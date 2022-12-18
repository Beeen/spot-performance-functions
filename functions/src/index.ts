//  The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
//  const functions = require('firebase-functions');

//  The Firebase Admin SDK to access Firestore.
//  const admin = require('firebase-admin');

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
admin.initializeApp();
import {Logging} from "@google-cloud/logging";
const logging = new Logging({
  projectId: process.env.GCLOUD_PROJECT,
});

// const express = require("express");
// const app = express();
// app.use(express.static("."));
// app.use(express.json());
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripe = require("stripe")("pk_test_51JWmMXAqPOYdz9ujfTkJ4VNx48TJX3Gtg1m8Pk41qNFMteqOepRHCOUMZQaTL00JZixm9HBTx7gIAzcb8U0PixDA00Hci4fj1w");
// This example sets up an endpoint using the Express framework.
// Watch this video to get started: https://youtu.be/rPR2aJ6XnAc.

// // Start writing functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

// Take the text parameter passed to this HTTP endpoint and insert it into
// Firestore under the path /messages/:documentId/original
exports.addMessage = functions.https.onRequest(async (req, res) => {
// Grab the text parameter.
  const original = req.query.text;
  // Push the new message into Firestore using the Firebase Admin SDK.
  const writeResult = await admin.firestore().collection("messages").add({original: original});
  // Send back a message that we've successfully written the message
  res.json({result: `Message with ID: ${writeResult.id} added.`});
});

// Listens for new messages added to /messages/:documentId/original and creates an
// uppercase version of the message to /messages/:documentId/uppercase
exports.makeUppercase = functions.firestore.document("/messages/{documentId}")
    .onCreate((snap, context) => {
      // Grab the current value of what was written to Firestore.
      const original = snap.data().original;

      // Access the parameter `{documentId}` with `context.params`
      functions.logger.log("Uppercasing", context.params.documentId, original);
      const uppercase = original.toUpperCase();
      // You must return a Promise when performing asynchronous tasks inside a Functions such as
      // writing to Firestore.
      // Setting an 'uppercase' field in Firestore document returns a Promise.
      return snap.ref.set({uppercase}, {merge: true});
    });

/**
 * When a user is created, create a Stripe customer object for them.
 *
 * @see https://stripe.com/docs/payments/save-and-reuse#web-create-customer
 */
exports.createStripeCustomer = functions.auth.user().onCreate(async (user) => {
  const customer = await stripe.customers.create({email: user.email});
  const intent = await stripe.setupIntents.create({
    customer: customer.id,
  });
  await admin.firestore().collection("stripe_customers").doc(user.uid).set({
    customer_id: customer.id,
    setup_secret: intent.client_secret,
  });
  return;
});

/**
 * When adding the payment method ID on the client,
 * this function is triggered to retrieve the payment method details.
 */
exports.addPaymentMethodDetails = functions.firestore
    .document("/stripe_customers/{userId}/payment_methods/{pushId}")
    .onCreate(async (snap, context) => {
      try {
        const paymentMethodId = snap.data().id;
        const paymentMethod = await stripe.paymentMethods.retrieve(
            paymentMethodId
        );

        await snap.ref.set(paymentMethod);
        // Create a new SetupIntent so the customer can add a new method next time.
        const intent = await stripe.setupIntents.create({
          customer: `${paymentMethod.customer}`,
        });

        await snap.ref.parent.parent!.set({
          setup_secret: intent.client_secret,
        }, {merge: true}
        );

        return;
      } catch (error) {
        await snap.ref.set({error: userFacingMessage(error)}, {merge: true});
        await reportError(error, {user: context.params.userId});
      }
    });
/**
   * When a payment document is written on the client,
   * this function is triggered to create the payment in Stripe.
   *
   * @see https://stripe.com/docs/payments/save-and-reuse#web-create-payment-intent-off-session
*/
// [START chargecustomer]


exports.createStripePayment = functions.firestore
    .document("stripe_customers/{userId}/payments/{pushId}")
    .onCreate(async (snap, context) => {
      const {amount, currency, paymentMethod} = snap.data();
      try {
        // Look up the Stripe customer id.
        const parentRef = await snap!.ref!.parent!.parent!.get();
        const customer = parentRef.data()!.customer_id;
        // Create a charge using the pushId as the idempotency key
        // to protect against double charges.
        const idempotencyKey = context.params.pushId;
        const payment = await stripe.paymentIntents.create({
          amount,
          currency,
          customer,
          paymentMethod,
          off_session: false,
          confirm: true,
          confirmation_method: "manual",
        },
        {idempotencyKey}
        );
        // If the result is successful, write it back to the database.
        await snap.ref.set(payment);
      } catch (error) {
        // We want to capture errors and render them in a user-friendly way, while
        // still logging an exception to Error Reporting.
        functions.logger.log(error);
        await snap.ref.set({error: userFacingMessage(error)}, {merge: true});
        await reportError(error, {user: context.params.userId});
      }
    });

// [END chargecustomer]

/**
   * When 3D Secure is performed, we need to reconfirm the payment
   * after authentication has been performed.
   *
   * @see https://stripe.com/docs/payments/accept-a-payment-synchronously#web-confirm-payment
   */
exports.confirmStripePayment = functions.firestore
    .document("stripe_customers/{userId}/payments/{pushId}")
    .onUpdate(async (change, context) => {
      if (change.after.data().status === "requires_confirmation") {
        const payment = await stripe.paymentIntents.confirm(
            change.after.data().id
        );
        change.after.ref.set(payment);
      }
    });

/**
   * When a user deletes their account, clean up after them
   */
exports.cleanupUser = functions.auth.user().onDelete(async (user) => {
  const dbRef = admin.firestore().collection("stripe_customers");
  const customer = (await dbRef.doc(user.uid).get()).data();
  await stripe.customers.del(customer!.customer_id);
  // Delete the customers payments & payment methods in firestore.
  const batch = admin.firestore().batch();
  const paymetsMethodsSnapshot = await dbRef
      .doc(user.uid)
      .collection("payment_methods")
      .get();
  paymetsMethodsSnapshot.forEach((snap) => batch.delete(snap.ref));
  const paymentsSnapshot = await dbRef
      .doc(user.uid)
      .collection("payments")
      .get();
  paymentsSnapshot.forEach((snap) => batch.delete(snap.ref));

  await batch.commit();

  await dbRef.doc(user.uid).delete();
  return;
});

/**
  * To keep on top of errors, we should raise a verbose error report with Error Reporting rather
  * than simply relying on functions.logger.error. This will calculate users affected + send you email
  * alerts, if you've opted into receiving them.
*/
// [START reporterror]
// eslint-disable-next-line require-jsdoc
function reportError(err: any, context = {}) {
  // This is the name of the log stream that will receive the log
  // entry. This name can be any valid log stream name, but must contain "err"
  // in order for the error to be picked up by Error Reporting.
  const logName = "errors";
  const log = logging.log(logName);

  // https://cloud.google.com/logging/docs/api/ref_v2beta1/rest/v2beta1/MonitoredResource
  // const metadata = {
  //   resource: {
  //     type: "cloud_function",
  //     labels: {
  //       "function_name": process.env.FUNCTION_NAME,
  //       "project_id": "",
  //       "region": "",
  //     },
  //   },
  // };

  const metadata = {
    timestamp: null,
    severity: null,
    httpRequest: null,
  };

  // https://cloud.google.com/error-reporting/reference/rest/v1beta1/ErrorEvent
  const errorEvent = {
    message: err.stack,
    serviceContext: {
      service: process.env.FUNCTION_NAME,
      resourceType: "cloud_function",
    },
    context: context,
  };

  // Write the error log entry
  return new Promise<void>((resolve, reject) => {
    log.write(log.entry(metadata, errorEvent), (error: any) => {
      if (error) {
        return reject(error);
      }
      return resolve();
    });
  });
}

// [END reporterror]

// eslint-disable-next-line valid-jsdoc
/**
 *Sanitize the error message for the user.
*/
function userFacingMessage(error: any) {
  return error.type ? error.message : "An error occurred, developers have been alerted";
}

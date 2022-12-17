// The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
//const functions = require('firebase-functions');

// The Firebase Admin SDK to access Firestore.
//const admin = require('firebase-admin');

import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
admin.initializeApp();

const express = require("express");
const app = express();
app.use(express.static("."));
app.use(express.json());
const stripe = require('stripe')('pk_test_51JWmMXAqPOYdz9ujfTkJ4VNx48TJX3Gtg1m8Pk41qNFMteqOepRHCOUMZQaTL00JZixm9HBTx7gIAzcb8U0PixDA00Hci4fj1w');
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
    const writeResult = await admin.firestore().collection('messages').add({original: original});
    // Send back a message that we've successfully written the message
    res.json({result: `Message with ID: ${writeResult.id} added.`});
    });

// Listens for new messages added to /messages/:documentId/original and creates an
// uppercase version of the message to /messages/:documentId/uppercase
exports.makeUppercase = functions.firestore.document('/messages/{documentId}')
    .onCreate((snap, context) => {
      // Grab the current value of what was written to Firestore.
      const original = snap.data().original;

      // Access the parameter `{documentId}` with `context.params`
      functions.logger.log('Uppercasing', context.params.documentId, original);
      
      const uppercase = original.toUpperCase();
      
      // You must return a Promise when performing asynchronous tasks inside a Functions such as
      // writing to Firestore.
      // Setting an 'uppercase' field in Firestore document returns a Promise.
      return snap.ref.set({uppercase}, {merge: true});
    });

app.post('/payment-sheet', async (req, res) => {
    // Use an existing Customer ID if this is a returning customer.
    const customer = await stripe.customers.create();
    const ephemeralKey = await stripe.ephemeralKeys.create(
    {customer: customer.id},
    {apiVersion: '2020-08-27'}
    );
    const paymentIntent = await stripe.paymentIntents.create({
    amount: 1099,
    currency: 'eur',
    customer: customer.id,
    automatic_payment_methods: {
        enabled: true,
    },
    });

    res.json({
    paymentIntent: paymentIntent.client_secret,
    ephemeralKey: ephemeralKey.secret,
    customer: customer.id,
    publishableKey: 'pk_test_51JWmMXAqPOYdz9ujfTkJ4VNx48TJX3Gtg1m8Pk41qNFMteqOepRHCOUMZQaTL00JZixm9HBTx7gIAzcb8U0PixDA00Hci4fj1w'
    });
});

app.listen(process.env.PORT, () =>
  console.log(`Node server listening on port ${process.env.PORT}!`)
);
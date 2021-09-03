const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const { checkRequestKey } = require("./keys");
const { time } = require("./time");
const randomstring = require('randomstring');
const { Client, Environment } = require("square");
const { getSquareSecret} = require('./keys')
const nodemailer = require('nodemailer');
const fs = require('fs');
const handlebars = require('handlebars');

 
router.post("/place_order", async(req, res) => {
  try {
    const { payment, contact, order, rewards, idKey, env} = req.body;
    let development = env === 'development';

    let authorized = await checkRequestKey(req.headers.authorization);
    // Not authorized 
    if(!authorized){
      res.status(400).send({ error: 'Not authorized'});
      return;
    }

    // store closed
    const { day, month, year, timestamp, storeIsOpen } = time();
    if(!storeIsOpen){
      res.status(400).send({ error: 'Store is closed at this time.'});
      return;
    }

    const orderId = randomstring.generate(18);
    let orderDetails, sqPayment, restaurantOrderDetails;
    let storePayment = Object.keys(payment.card).length === 0 && payment.card.constructor === Object;
    
    if(!storePayment){

      let { SQ_TOKEN } = await getSquareSecret(development ? 'DEV' : 'PROD');
          
        
      const client = new Client({
        environment: development ? Environment.Sandbox : Environment.Production,
        accessToken: SQ_TOKEN,
      })

      const paymentResult = await client.paymentsApi.createPayment({
        sourceId: payment.card.cofId,
        idempotencyKey: idKey,
        customerId: payment.customerId,
        amountMoney: {
          amount: Math.round((order.total - order.tip) * 100),
          currency: 'USD'
        },
        tipMoney: {
          amount: Math.round(order.tip * 100),
          currency: 'USD'
        },
        autocomplete: false,
      });
      sqPayment = paymentResult.result.payment;   
    }
  
    orderDetails = {
      contact,
      order: {
        ...order,
        orderId,
        createdAt: timestamp,
        type: payment.type
      },
      square: storePayment ? {} :{
        brand: sqPayment.cardDetails.card.cardBrand,
        lastFourDigit: sqPayment.cardDetails.card.last4,
      },
      orderStatus: {
        refund: false,
        refundAmount: 0,
        cancel:false,
      }
    }

    restaurantOrderDetails = {
      contact,
      order: {
        ...order,
        orderId,
        createdAt: timestamp,
        type: payment.type
      },
      square: storePayment ? {} :{
        paymentId: sqPayment.id,
        orderId: sqPayment.orderId,
        brand: sqPayment.cardDetails.card.cardBrand,
        lastFourDigit: sqPayment.cardDetails.card.last4,
      },
      orderStatus: {
        refund: false,
        refundAmount: 0,
        cancel:false,
      }
    }
  
    let tempPoint = Math.round(rewards.point + order.pointEarned - order.pointUsed);
    let tempPointDetail = [...rewards.details];
    tempPointDetail.unshift({
      orderId: orderId,
      createdAt: timestamp,
      action: 'add',
      amount: order.pointEarned,
    });
    if(order.pointUsed > 0){
      tempPointDetail.unshift({
        orderId: orderId,
        createdAt: timestamp,
        action: 'subtract',
        amount: order.pointUsed,
      });
    }

   
    let batch = admin.firestore().batch();
    let unprocess = [];

    if (sqPayment != null) {
        let unprocessData = (await admin.firestore().collection(`${development ?  "unprocessedTest" : "unprocessPayment"}`)
        .doc(`${month}${day}`).get()).data();
      // if unprocess is null or it is empty
       unprocess = ( unprocessData == undefined || unprocessData.length <= 0 ) ? [] : unprocessData.paymentId; 

       // if there is no data in the array, add the new id and set the data
      if(unprocess.length <= 0){
        unprocess.unshift(sqPayment.id);
        batch.set(
          admin
            .firestore()
            .collection(`${development ? "unprocessedTest" : "unprocessPayment" }`)
            .doc(`${month}${day}`),
          {
            paymentId: unprocess,
          }
        );
      } else {
        // if there is data in the array, we want to add the new id and update the data
        unprocess.unshift(sqPayment.id);
        batch.update(
          admin
            .firestore()
            .collection(`${development ? "unprocessedTest" : "unprocessPayment" }`)
            .doc(`${month}${day}`),
          {
            paymentId: unprocess,
          }
        );
      }
    }

      batch.set(admin.firestore().collection(`${development ? 'orderTest' : 'order' }/${year}/${month}`)
        .doc(`${orderId}`), restaurantOrderDetails);
      batch.set(admin.firestore().collection(`${development ? 'newOrderTest' : 'newOrder'}`)
      .doc(`${orderId}`), restaurantOrderDetails);
      batch.set(admin.firestore().collection(`${development ? 'usersTest' : 'users' }/${contact.userId}/order`)
        .doc(`${orderId}`), orderDetails);
      batch.set(admin.firestore().collection(`${development ? 'usersTest' : 'users' }/${contact.userId}/rewards`)
        .doc('points'), {
          'point': tempPoint,
          'pointDetails': tempPointDetail
        });
    await batch.commit();

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'taipeicuisine68@gmail.com',
        pass: 'dbldkycbiekxazzv'
      }
    })

    var readHTMLFile = function(path, callback) {
      fs.readFile(path, {encoding: 'utf-8'}, function (err, html) {
          if (err) {
              throw new Error(err.message);
              callback(err);
          }
          else {
              callback(null, html);
          }
      });
  };

  
  let showPaymentType = '';
  if(payment.type === 'cash'){
    showPaymentType = 'Pay In Cash'
  } else if (payment.type == 'card'){
    showPaymentType = 'Pay Card In Store'
  } else if(payment.type == 'Prepaid' || payment.type == 'prepaid' || payment.type == 'one-time'){
    showPaymentType = 'Prepaid'
  }
  let orderString = [];
  order.items.forEach((item) => {
    let tempString = `<tr style="padding">
        <td style="text-align: left;">
        <p style="font-size: 15px;">${item.foodId}. ${item.foodName}</p>
        <p style="font-size: 13px; color: #848484">${item.foodNameChinese}       $${item.price.toFixed(2)}</p>
        </td>
        <td style="text-align: left">X${item.count}</td>
        <td style="text-align: left">$${item.total.toFixed(2)}</td>
      </tr>`;
    orderString.push(tempString);
  })

  readHTMLFile(__dirname + '/email/order_email.html', function(err, html) {
    var template = handlebars.compile(html);
    var replacements = {
      customerName: `${contact.name}`,
      customerPhone: `${contact.phone}`,
      orderId: orderId,
      paymentMethod: `${showPaymentType}`,
      orderType: order.isDelivery ? 'Delivery' : 'Pick Up',
      deliveryTitle: `${order.isDelivery ? 'Delivery To' : ''}`,
      deliveryAddress: order.isDelivery ? order.address.address.replace(', USA', `, ${order.address.zipcode}`) : '',
      deliveryApt: order.isDelivery ? `${order.address.apt != '' ? `Apt: ${order.address.apt}` : ''}` : '',
      deliveryBusiness: order.isDelivery ? `${order.address.business != '' ? `Business Name: ${order.address.business}` : ''}`: '',
      itemCount: `${order.totalItemCount}`,
      discountTitle: order.discount > 0 ? 'Discount' : '',
      discountAmount: order.discount > 0 ? `- $${order.discount.toFixed(2)}` : '',
      lunchDiscountTitle: order.lunchDiscount > 0 ? 'Lunch Discount' : '',
      lunchDiscountAmount: order.lunchDiscount > 0 ? `- $${order.lunchDiscount.toFixed(2)}` : '',
      subtotalAmount:  `$${order.subtotal.toFixed(2)}`,
      taxAmount: `$${order.tax.toFixed(2)}`,
      deliveryFeeTitle: order.isDelivery ? `Delivery Fee` : '',
      deliveryAmount: order.isDelivery ? `$${order.delivery.toFixed(2)}` : '',
      tipAmount: `$${order.tip.toFixed(2)}`,
      totalAmount: `${order.total.toFixed(2)}`,
      items: orderString.join(''),
    };
    var htmlToSend = template(replacements);
    var mailOptions = {
      from: 'Taipei Cuisine <taipeicuisine68@gmail.com>',
      to: contact.email,
      subject: `Order Confirmation (${orderId})`,
      html: htmlToSend,
      attachments: [{
        filename: 'bee.png',
        path: `${__dirname}/email/images/bee.png`,
        cid: 'bee.png' //same cid value as in the html img src
      },
      {
        filename: 'round_corner.png',
        path: `${__dirname}/email/images/round_corner.png`,
        cid: 'round_corner.png' //same cid value as in the html img src
      },
      {
        filename: 'whitelogo.png',
        path: `${__dirname}/email/images/whitelogo.png`,
        cid: 'whitelogo.png' //same cid value as in the html img src
      },
      {
        filename: 'Mama_Bakery.png',
        path: `${__dirname}/email/images/Mama_Bakery.png`,
        cid: 'Mama_Bakery.png' //same cid value as in the html img src
      }],
    }

    transporter.sendMail(mailOptions, function(err, response) {
      if (err) {
        res.status(400).send({ error: err});
      } else {
        res.status(200).send({
          order: orderDetails,
          reward: {
            point: tempPoint,
            pointDetails: tempPointDetail
          }
        })
      }
    })

    // customerName,
    // customerPhone
    // orderId
    // paymentMethod
    // deliveryTitle
    // deliveryAddress
    // deliveryCityAndZip
    // deliveryApt
    // deliveryBusiness
    // itemCount
    // discountTitle
    // discountAmount
    // lunchDiscountTitle
    // lunchDiscountAmount
    // subtotalAmount
    // taxAmount
    // deliveryTitle
    // deliveryAmount
    // tipAmount
    // totalAmount
    // items 

});
  } catch (errorMessage) {
    console.log(errorMessage);
    let error = '';
    if(errorMessage.result){
      switch (errorMessage.result.errors[0].code) {
        case "CVV_FAILURE":
          error = "The CVV entered is incorrect" ;
          break;
        case "BAD_EXPIRATION":
          error = "The card expiration date is either missing or incorrectly formatted." ;
          break;
        case "ADDRESS_VERIFICATION_FAILURE":
          error = "The postal code is invalid";
          break;
        case "CARD_EXPIRED":
        error = "The card is expired"
          break;
        case "CARD_NOT_SUPPORTED":
        error = "The card is not supported either in the geographic region or by the MCC"
          break;
        case "EXPIRATION_FAILURE":
        error = "The card expiration date is either invalid or indicates that the card is expired."
          break;
        case "INSUFFICIENT_FUNDS":
        error = "The funding source has insufficient funds to cover the payment."
          break;
        case "INVALID_ACCOUNT":
        error = "The card issuer was not able to locate account on record."
          break;
        case "INVALID_CARD":
        error = "The credit card cannot be validated based on the provided details."
          break;
        case "INVALID_CARD_DATA":
        error = "The provided card data is invalid."
          break;
        case "INVALID_EXPIRATION":
        error = "The expiration date for the payment card is invalid."
          break;
        case "INVALID_POSTAL_CODE":
        error = "The postal code is incorrectly formatted."
          break;
        case "PAN_FAILURE":
        error = "The specified card number is invalid."
          break;
        default:
          error = "Unknown error occur while processing the credit card."
      };
    }
    res.status(400).send({ error: error !== '' ? error : 'Something went wrong'});
  }
})

module.exports = router;

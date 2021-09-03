const express = require("express");
const router = express.Router();
const { checkRequestKey, getTwilioKeys } = require("./keys");
const admin = require("firebase-admin");
const twilio = require("twilio");

const setCustomer = (userId, res, development) => {
  admin.firestore().collection(`/${development ? 'usersTest' : 'users'}/${userId}/customer`).doc('details').set({
    address: {
      apt: "",
      business: "",
      address: "",
      zipcode: "",
      deliveryFee: 0,
    },
    billing: {
      cards: [],
      customerId: "",
    },
    customer: {
      name: '',
      phone: "",
      verifiedNumbers: [],
    },
    language: "english"
  }).catch((e) => {
    res.status(400).send({ error : 'Failed to create user data...'});
    return;
  })
}

const setReward = (userId, res, development) => {
  admin.firestore().collection(`/${development ? 'usersTest' : 'users'}/${userId}/rewards`).doc('points').set({
    point: 0,
      pointDetails: [],
  }).catch(e => {
    res.status(400).send({ error : 'Failed to create user data...'});
    return;
  })
}

router.post("/signin", async (req, res) => {
    try {
      // create the batch
      const { userId, env } = req.body;
      let development = env === 'development';
      let customerInfoRef = `${development ? 'usersTest' : 'users'}/${userId}/customer`;
      let rewardInfoRef = `${development ? 'usersTest' : 'users'}/${userId}/rewards`;
      let orderInfoRef = `${development ? 'usersTest' : 'users'}/${userId}/order`;

      let userDetail = (await admin.firestore().collection(customerInfoRef).get()).docs;
      let rewardDetail = (await admin.firestore().collection(rewardInfoRef).get()).docs;

      if(userDetail.length === 0){
        setCustomer(userId, res, development);
      }

      if(rewardDetail.length === 0){
        setReward(userId, res, development);
      }
        let customerInfo, rewardInfo, server, orderList = [];
        // retrieve all essential information about the server
        await admin.firestore().runTransaction(async (transaction) => {
          server = await (await transaction.get(admin.firestore().collection('admin').doc('details'))).data().server;
          // retrieve customer information: include billing, address, and customer info(name and phone)
          customerInfo = (await transaction.get(admin.firestore().collection(customerInfoRef).doc('details'))).data();
          // retrieve information associated with reward    
          rewardInfo = (await transaction.get(admin.firestore().collection(rewardInfoRef).doc('points'))).data();
          // retrieve information associated with order
          (await transaction.get(admin.firestore().collection(orderInfoRef).orderBy('order.createdAt', 'desc'))).docs
          .forEach((el) => 
            orderList.push(el.data())
          );
        });
    
        res.status(200).send({ 
          result: {
            customerInfo, // billing information 
              rewardInfo, // reward information
              orderList, // order information
              server: {
                isAdmin: server.adminId.includes(userId),
                message: server.message,
                requestKey: server.requestKey,
                status: server.status,
                rewardPercentage: server.rewardPercentage,
                key: server.key
              }
        }})
    } catch (error) {
      console.log(error);
      // if any error, show this generic error message
      res.status(400).send({ error : 'Failed to retreive information, try again later..'});
    }
 
}); 

router.post("/send_code", async (req, res) => {
  try {
    // Check the authorized header sent with the request
    let authroized = await checkRequestKey(req.headers.authorization);

    // Only authroized request will proceed
    if (authroized) {
        const { phone, code, env } = req.body;

        let t_sid, t_token, t_number;

        if(env === 'development'){
          t_sid = 'AC68da6de4212e4468539638e383da6547';
          t_token = '148d681baf7f2e0675b3060f37b7322f';
          t_number = '8187405541'
        } else {
          // Get the keys from the server
          let { TWILIO_ACCOUNT_SID, TWILIO_TOKEN, TWILIO_NUMBER } = await getTwilioKeys();
          t_sid = TWILIO_ACCOUNT_SID;
          t_token = TWILIO_TOKEN;
          t_number = TWILIO_NUMBER;
        }
       
        // Create a new instance of the Twilio object with the keys
        let client = new twilio(t_sid, t_token);

        // Construct the message that we would want to send to the client
        client.messages.create({
          body: `Your verification code for Taipei Cuisine: ${code}`,
          to: `+1${phone}`, // Text this number
          from: `+1${t_number}`, // From a valid Twilio number
        });

        // Once the message is sent, we would want to notify the front end
        res.status(200).send({ success: "Success" });
      } else {
      // if the request key is not authorized, we will just send back the rejection message
      res.status(400).send({ error: "Not authorized" });
    }
  } catch (error) {
    console.log(error)

    res.status(400).send({ error: error.message ? error.message :"Failed to send code, try again later"})
  }
  
});

router.post("/get_report", async(req, res) => {
  try {
    // Check the authorized header sent with the request
    let authroized = await checkRequestKey(req.headers.authorization);

    // Only authroized request will proceed
    if (authroized) {
      const { month, year} = req.body
      let orders =  (await ( admin.firestore().collection(`order/${year}/${month}`).orderBy('order.createdAt', 'desc')).get()).docs;

      let summary = {
        subtotal: 0,
        discount: 0,
        tax: 0,
        tip: 0,
        delivery: 0,
        refund: 0,
        total: 0,
      }

      tempList = [];

      orders.map(order => {    
        let data = order.data();

        tempList.push(data);
        summary = {
          subtotal: Math.round((summary.subtotal + (data.order.subtotal - data.order.lunchDiscount) + Number.EPSILON) * 100) / 100,
          discount: Math.round((summary.discount + data.order.pointUsed + Number.EPSILON) * 100) / 100,
          tax:  Math.round((summary.tax + data.order.tax + Number.EPSILON) * 100) / 100,
          tip:  Math.round((summary.tip + data.order.tip + Number.EPSILON) * 100) / 100,
          delivery:  Math.round((summary.delivery + data.order.delivery + Number.EPSILON) * 100) / 100,
          refund: Math.round((summary.refund + data.orderStatus.refundAmount + Number.EPSILON) * 100) / 100,
          total:  Math.round(((summary.total + data.order.total) + Number.EPSILON) * 100) / 100,
        }
      }) 

      res.send({
        orders: tempList,
        summary
      })
    } else {
      res.send({ error: 'Not authorized'})
    }
  } catch (error) {
    console.log(error)
    res.send({ error: error.message ? error.message : 'Fail to get report.'})
  }
})

router.post("/get_report_old", async(req, res) => {
  try {
    // Check the authorized header sent with the request
    let authroized = await checkRequestKey(req.headers.authorization);

    // Only authroized request will proceed
    if (authroized) {
      const { month, year} = req.body
      let orders =  (await ( admin.firestore().collection(`order/${year}/${month}`).orderBy('createdAt', 'desc')).get()).docs;

      let summary = {
        subtotal: 0,
        discount: 0,
        tax: 0,
        tip: 0,
        delivery: 0,
        refund: 0,
        total: 0,
      }

      tempList = [];

      orders.map(order => {    
        let data = order.data();

        tempList.push(data);
        summary = {
          subtotal: Math.round((summary.subtotal + (data.subtotal - data.lunchDiscount) + Number.EPSILON) * 100) / 100,
          discount: Math.round((summary.discount + data.pointUsed + Number.EPSILON) * 100) / 100,
          tax:  Math.round((summary.tax + data.tax + Number.EPSILON) * 100) / 100,
          tip:  Math.round((summary.tip + data.tip + Number.EPSILON) * 100) / 100,
          delivery:  Math.round((summary.delivery + data.deliveryFee + Number.EPSILON) * 100) / 100,
          refund: Math.round((summary.refund + data.refund_amount + Number.EPSILON) * 100) / 100,
          total:  Math.round(((summary.total + data.total) + Number.EPSILON) * 100) / 100,
        }
      }) 

      res.send({
        orders: tempList,
        summary
      })
    } else {
      res.send({ error: 'Not authorized'})
    }
  } catch (error) {
    console.log(error)
    res.send({ error: error.message ? error.message : 'Fail to get report.'})
  }
})


// For own use only
// router.get('/clean', async (req, res) => {
//   let userList = []
//   let filterUser = []
//   await admin.auth().listUsers(500).then((listUsersResult) => {
//     listUsersResult.users.forEach((userRecord) => {
//       userList.push(userRecord)
//     })

//     filterUser = userList.filter((user) => {
//       return !user.emailVerified && user.providerData[0].providerId === 'password'
//     })

//     console.log(filterUser.length);
//   }).catch((error) => {
//     console.log('Error listing users:', error);
//   });;

//   filterUser.map(user => {
//     admin.auth().deleteUser(user.uid)
//     admin.firestore().collection('users').doc(user.uid).delete()
//   })


//   res.send(filterUser)
  
// })


// RESET CUSTOMER ID TEMPORARY USAGE
// router.get('/customer_id_reset', async (req, res) => {
//   let userList = []
//   let lengthList = []
//   await admin.auth().listUsers(1000).then((listUsersResult) => {
//     listUsersResult.users.forEach((userRecord) => {
//       userList.push(userRecord)
//     })

//     userList.map(async (user) => {
        
//         let customer = (await admin.firestore().collection(`usersTest/${user.uid}/customer`).get()).docs;

//         if(customer.length !== 0){
//           admin.firestore().collection(`users/${user.uid}/customer`).doc('details').update({
//             billing: {
//               cards: [],
//               customerId:''
//             }
//           });
//         }
 
//     })

//   }).catch((error) => {
//     console.log('Error listing users:', error);
//   });;

//   res.send('success')
// })

module.exports = router;


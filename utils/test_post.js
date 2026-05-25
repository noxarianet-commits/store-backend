const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const form = new FormData();
form.append('id', `NX-TEST${Date.now()}`);
form.append('product', 'Mobile Legends');
form.append('variant', '5 Diamonds');
form.append('price', 2300);
form.append('wa_number', '08123456');
form.append('email', 'test@test.com');
form.append('payment_method', 'QRIS');

form.append('proof_image', fs.createReadStream(path.join(__dirname, 'dummy.jpg')));

axios.post('http://localhost:3000/api/order', form, {
    headers: form.getHeaders()
}).then(res => {
    console.log("Success:", res.data);
}).catch(err => {
    console.log("Error:", err.response ? err.response.data : err.message);
});

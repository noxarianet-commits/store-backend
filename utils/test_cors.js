const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const form = new FormData();
form.append('id', `NX-TEST${Date.now()}`);

axios.post('http://localhost:3000/api/order', form, {
    headers: {
        ...form.getHeaders(),
        'Origin': 'http://localhost:5174'
    }
}).then(res => {
    console.log("Success:", res.data);
}).catch(err => {
    console.log("Error:", err.response ? err.response.data : err.message);
    console.log("Status:", err.response ? err.response.status : 'N/A');
});

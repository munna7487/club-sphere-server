// const fs = require('fs');
// const key = fs.readFileSync("./club-sphere-11e4b-firebase-adminsdk-fbsvc-863ee592e2.json", 'utf8')
// const base64 = Buffer.from(key).toString('base64')
// console.log(base64)
const fs = require('fs');

const key = fs.readFileSync("./club-sphere-11e4b-firebase-adminsdk-fbsvc-863ee592e2.json", "utf8");
const base64 = Buffer.from(key).toString("base64");

console.log(base64);

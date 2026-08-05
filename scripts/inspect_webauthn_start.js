const crypto = require('crypto');
const { generateRegistrationOptions } = require('@simplewebauthn/server');
const userID = crypto.randomBytes(16).toString('hex');
const userIDBuffer = Buffer.from(userID, 'hex');
(async () => {
    const options = await generateRegistrationOptions({
        rpID: 'localhost',
        rpName: 'Smart Locker System',
        userID: userIDBuffer,
        userName: `user_${userID}`,
        attestationType: 'none',
        authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
        },
        userVerification: 'required',
    });
    console.log('typeof', typeof options);
    console.log('constructor', options && options.constructor && options.constructor.name);
    console.log('keys', Object.keys(options));
    console.log('own props', Object.getOwnPropertyNames(options));
    console.log('has toJSON', typeof options.toJSON);
    if (typeof options.toJSON === 'function') {
        const json = options.toJSON();
        console.log('toJSON keys', Object.keys(json));
        console.log('toJSON', json);
    }
    console.log('stringify', JSON.stringify(options));
})();

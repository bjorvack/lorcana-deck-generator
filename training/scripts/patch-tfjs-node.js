const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../node_modules/@tensorflow/tfjs-node/dist/nodejs_kernel_backend.js');

if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    // Replace util_1.isNullOrUndefined with a polyfill
    const patchedContent = content.replace(/util_1\.isNullOrUndefined/g, '(x => x == null)');

    if (content !== patchedContent) {
        fs.writeFileSync(filePath, patchedContent);
        console.log('Successfully patched tfjs-node/dist/nodejs_kernel_backend.js');
    } else {
        console.log('tfjs-node already patched or pattern not found.');
    }
} else {
    console.warn('tfjs-node/dist/nodejs_kernel_backend.js not found. Skipping patch.');
}

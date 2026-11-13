'use strict';
const { readFileSync } = require('node:fs');
const { price } = require('./adapter.cjs');
process.stdout.write(JSON.stringify(price(JSON.parse(readFileSync(0, 'utf8')))));

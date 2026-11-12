/* Chat policy checks. Run with: node test/chatfilter.js */
"use strict";

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../web/js/chatfilter.js'), 'utf8'));
const C = window.RBLXchatfilter;

assert.deepStrictEqual(C.clean('hello'), { ok: true, text: 'hello' });
assert.deepStrictEqual(C.clean('  hello   world  '), { ok: true, text: 'hello world' });
assert.strictEqual(C.clean('').ok, false);
assert.strictEqual(C.clean('héllo').ok, false);
assert.strictEqual(C.clean('😀').ok, false);
assert.strictEqual(C.clean('a'.repeat(101)).ok, false);
assert.strictEqual(C.clean('a'.repeat(13)).ok, false);
assert.strictEqual(C.clean('fuck').text, '####');
assert.strictEqual(C.clean('sh1t').text, '####');
assert.strictEqual(C.clean('b1tch').text, '#####');
assert.strictEqual(C.clean('class').text, 'class');
assert.strictEqual(C.clean('ass').text, 'ass');
assert.strictEqual(C.clean('hello\nworld').ok, false);

console.log('ALL CHATFILTER TESTS PASSED');

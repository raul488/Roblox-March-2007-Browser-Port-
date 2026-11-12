/* Username policy checks. Run with: node test/namepolicy.js */
"use strict";

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../web/js/namepolicy.js'), 'utf8'));
const P = window.RBLXnamepolicy;

assert.strictEqual(P.sanitize('Player1'), 'Player1');
assert.strictEqual(P.sanitize('  Alice  Bob__X  '), 'Alice Bob_X');
assert.strictEqual(P.sanitize('A!l😀ice'), 'Alice');
assert.strictEqual(P.sanitize('a  b'), 'a b');
assert.strictEqual(P.sanitize('a_b_c'), 'a_bc');
assert.strictEqual(P.sanitize('___'), 'Player1');
assert.strictEqual(P.sanitize('', ''), '');
assert.strictEqual(P.sanitize('x'.repeat(40)), 'x'.repeat(20));
assert.strictEqual(P.sanitize('one two three').includes('  '), false);
assert.strictEqual((P.sanitize('one two three').match(/ /g) || []).length, 1);
assert.strictEqual((P.sanitize('a_b_c_d').match(/_/g) || []).length, 1);
assert.strictEqual(P.sanitize('a'.repeat(10) + '_' + 'b'.repeat(10)).length, 20);

console.log('ALL NAMEPOLICY TESTS PASSED');

/* Super Safe Chat phrase set and send flag.
 * Run with: node test/safechat.js */
"use strict";

const fs=require('fs');
const vm=require('vm');
const assert=require('assert');
const path=require('path');

const xml='<roblox><utterance>Hello' +
  '<utterance>Hi there!</utterance>' +
  '<utterance>Questions<utterance>How are you?</utterance></utterance>' +
  '</utterance></roblox>';

global.window={ CORE_ASSETS:{ 'content/fonts/safechat.xml':xml } };
vm.runInThisContext(fs.readFileSync(path.join(__dirname,'../web/js/safechat.js'),'utf8'));
const S=window.RBLXsafechat;

assert.strictEqual(S.isPhrase('Hi there!'), true);
assert.strictEqual(S.isPhrase('How are you?'), true);
assert.strictEqual(S.isPhrase('Hello'), false, 'category was treated as a phrase');
assert.strictEqual(S.isPhrase('not a phrase'), false);
assert.strictEqual(S.phrases().size, 2);

let sent=null;
window.RBLXnetgame={ active:{ chat:(text,safe)=>{ sent={ text, safe }; } } };
S.send('Hi there!');
assert.deepStrictEqual(sent, { text:'Hi there!', safe:true });

console.log('ALL SAFECHAT TESTS PASSED');

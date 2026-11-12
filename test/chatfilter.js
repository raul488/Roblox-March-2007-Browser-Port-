/* Chat policy checks. Run with: node test/chatfilter.js */
"use strict";

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../web/js/safewords.js'), 'utf8'));
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

/* Spaces, punctuation, inserted digits and doubled letters. */
assert.strictEqual(C.clean('fuc k').text, '### #');
assert.strictEqual(C.clean('fu2ck').text, '#####');
assert.strictEqual(C.clean('f u c k').text, '# # # #');
assert.strictEqual(C.clean('f.u.c.k').text, '#.#.#.#');
assert.strictEqual(C.clean('fuuuuck').text, '#######');
assert.strictEqual(C.clean('f*ck').text, '#*##');
assert.strictEqual(C.clean('f**k').text, '#**#');
assert.strictEqual(C.clean('sh*t').text, '##*#');
assert.strictEqual(C.clean('b*tch').text, '#*###');
assert.strictEqual(C.clean('b**ch').text, '#**##');
assert.strictEqual(C.clean('c*nt').text, '#*##');
assert.strictEqual(C.clean('d*ck').text, '#*##');
assert.strictEqual(C.clean('wh*re').text, '##*##');
assert.strictEqual(C.clean('n*gger').text, '#*####');
assert.strictEqual(C.clean('f*ggot').text, '#*####');
assert.strictEqual(C.clean('a**hole').text, '#**####');
assert.strictEqual(C.clean('k*ke').text, '#*##');
assert.strictEqual(C.clean('s**t').text, '#**#');
assert.strictEqual(C.clean('c**t').text, '#**#');
assert.strictEqual(C.clean('d**k').text, '#**#');
assert.strictEqual(C.clean('p***y').text, '#***#');

/* Fuzzy pass for out-of-vocabulary typos, with the generated safe list. */
assert.strictEqual(C.clean('fawk').text, '####');
assert.strictEqual(C.clean('fawka').text, '#####');
assert.strictEqual(C.clean('fucka').text, '#####');
assert.strictEqual(C.clean('fucky').text, '#####');
assert.strictEqual(C.clean('fuckz').text, '#####');
assert.strictEqual(C.clean('bitcx').text, '#####');
assert.strictEqual(C.clean('faggott').text, '#######');
assert.strictEqual(C.clean('shitez').text, '######');
assert.strictEqual(C.clean('shite').text, '#####');
assert.strictEqual(C.clean('duck').text, 'duck');
assert.strictEqual(C.clean('luck').text, 'luck');
assert.strictEqual(C.clean('suck').text, 'suck');
assert.strictEqual(C.clean('tuck').text, 'tuck');
assert.strictEqual(C.clean('muck').text, 'muck');
assert.strictEqual(C.clean('puck').text, 'puck');
assert.strictEqual(C.clean('buck').text, 'buck');
assert.strictEqual(C.clean('funk').text, 'funk');
assert.strictEqual(C.clean('yuck').text, 'yuck');
assert.strictEqual(C.clean('chuck').text, 'chuck');
assert.strictEqual(C.clean('beach').text, 'beach');
assert.strictEqual(C.clean('beech').text, 'beech');
assert.strictEqual(C.clean('bench').text, 'bench');
assert.strictEqual(C.clean('batch').text, 'batch');
assert.strictEqual(C.clean('botch').text, 'botch');
assert.strictEqual(C.clean('butch').text, 'butch');
assert.strictEqual(C.clean('maggot').text, 'maggot');
assert.strictEqual(C.clean('regard').text, 'regard');
assert.strictEqual(C.clean('idiom').text, 'idiom');
assert.strictEqual(C.clean('where').text, 'where');
assert.strictEqual(C.clean('pushy').text, 'pushy');
assert.strictEqual(C.clean('shirts').text, 'shirts');
assert.strictEqual(C.clean('shifty').text, 'shifty');
assert.strictEqual(C.clean('modest').text, 'modest');
assert.strictEqual(C.clean('rakes').text, 'rakes');
assert.strictEqual(C.clean('slots').text, 'slots');
assert.strictEqual(C.clean('batches').text, 'batches');
assert.strictEqual(C.clean('counts').text, 'counts');
assert.strictEqual(C.clean('booms').text, 'booms');
assert.strictEqual(C.clean('ducks').text, 'ducks');
assert.strictEqual(C.clean('fick').text, 'fick');
assert.strictEqual(C.clean('nani').text, 'nani');
assert.strictEqual(C.clean('f@ck').text, '####');
assert.strictEqual(C.clean('2fuck').text, '#####');
assert.strictEqual(C.clean('fuck2').text, '#####');
assert.strictEqual(C.clean('fuck you').text, '#### ###');
assert.strictEqual(C.clean('mother fucker').text, '###### ######');
assert.strictEqual(C.clean('n i g g e r').text, '# # # # # #');
assert.strictEqual(C.clean('m0therfuck3r').text, '############');
assert.strictEqual(C.clean('puuussy').text, '#######');

/* Ordinary words containing a bad fragment stay intact. */
assert.strictEqual(C.clean('scunthorpe').text, 'scunthorpe');
assert.strictEqual(C.clean('therapist').text, 'therapist');
assert.strictEqual(C.clean('peninsula').text, 'peninsula');
assert.strictEqual(C.clean('dickens').text, 'dickens');
assert.strictEqual(C.clean('grape').text, 'grape');
assert.strictEqual(C.clean('shitake').text, 'shitake');
assert.strictEqual(C.clean('cocktail').text, 'cocktail');
assert.strictEqual(C.clean('document').text, 'document');
assert.strictEqual(C.clean('analysis').text, 'analysis');
assert.strictEqual(C.clean('uranus').text, 'uranus');
assert.strictEqual(C.clean('bob').text, 'bob');
assert.strictEqual(C.clean('con').text, 'con');
assert.strictEqual(C.clean('gok').text, 'gok');

console.log('ALL CHATFILTER TESTS PASSED');

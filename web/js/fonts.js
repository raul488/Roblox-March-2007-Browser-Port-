/* ============================================================
 * fonts.js  the real 2007 Comic Sans MS files, registered as web fonts.
 *
 * The 2007 client rendered its HUD text with Fonts\comics.fnt (decomp
 * :526125), which is a BMFont of Microsoft Comic Sans MS, and the 2007
 * website styled its HTML with the same face:
 *  - site body text (descriptions, blurbs, forum/profile text) in
 *    Comic Sans MS Regular at 10pt/12pt;
 *  - nav buttons + title headers in Comic Sans MS forced bold via
 *    font-weight:bold (the comicbd.ttf glyphs);
 *  - in-game HUD text (chat, player names/leaderboard) through the
 *    system comic.ttf/comicbd.ttf, with headers/hints/banners bold for
 *    readability over the 3D scene.
 *
 * COMIC.TTF (regular) and COMICBD.TTF (bold) are embedded in coreAssets.js
 * as FONT_DATA data-URLs  Chrome refuses @font-face src pointing at
 * file:// URLs (CORS), so the shipped bytes must be inlined.  Both are
 * registered under the family name 'Comic Sans MS' at weights 400/700 so
 * every existing CSS rule (and the over-head canvas ctx.font strings)
 * resolves to the shipped faces with zero rule churn.
 * ============================================================ */
(function(){
"use strict";
var DATA=(typeof window!=='undefined')&&window.FONT_DATA||{};

/* pure text building so the headless suite can assert the rules */
function cssText(){
  var reg=DATA['fonts/comic.ttf'], bold=DATA['fonts/comicbd.ttf'];
  if (!reg||!bold) return '';
  return '@font-face{font-family:"Comic Sans MS";font-style:normal;' +
         'font-weight:400;src:url('+reg+') format("truetype");}\n' +
         '@font-face{font-family:"Comic Sans MS";font-style:normal;' +
         'font-weight:700;src:url('+bold+') format("truetype");}';
}

var ready=null;
function register(){
  if (ready) return ready;
  if (typeof document==='undefined'||typeof FontFace==='undefined') return null;
  if (!DATA['fonts/comic.ttf']||!DATA['fonts/comicbd.ttf']) return null;
  if (!window.RBLXfontsCSS){
    window.RBLXfontsCSS=true;
    var st=document.createElement('style');
    st.id='rblx2007fonts';
    st.textContent=cssText();
    (document.head||document.documentElement).appendChild(st);
  }
  /* kick both faces over the network stack (data URLs decode instantly)
   * so canvas text (over-head tag) and the DOM settle on comic.ttf quickly */
  ready=Promise.all([
    document.fonts.load('13px "Comic Sans MS"'),
    document.fonts.load('bold 13px "Comic Sans MS"'),
    document.fonts.load('bold 26px "Comic Sans MS"')
  ]).then(function(){ return true; }).catch(function(){ return false; });
  return ready;
}

if (typeof document!=='undefined'){
  if (document.readyState!=='loading') register();
  else document.addEventListener('DOMContentLoaded', register, {once:true});
}

window.RBLXfonts={ cssText:cssText, register:register,
                   get ready(){
                     return register()||Promise.resolve(false);
                   } };
})();

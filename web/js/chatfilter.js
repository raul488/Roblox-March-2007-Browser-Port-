/* ============================================================
 * chatfilter.js  player-chat policy.
 *
 * - printable ASCII only (no Unicode/emoji/control characters)
 * - 100 characters max
 * - repeated-character flood guard
 * - profanity/slur mask that still sees through spaces, punctuation,
 *   leetspeak, inserted digits and doubled letters ("fuc k", "fu2ck")
 *
 * This is a starter list, not a complete moderation system. The host
 * applies it to every joiner message; the client applies it locally too.
 * ============================================================ */
(function () {
  "use strict";

  var MAX = 100;
  var MAX_REPEAT = 12;

  /* One normalized character per leet symbol.  '2' is treated as a filler
   * in the strip pass below, which is what catches "fu2ck". */
  var LEET = {
    '0':'o', '1':'i', '2':'z', '3':'e', '4':'a', '5':'s',
    '6':'g', '7':'t', '8':'b', '9':'g',
    '@':'a', '$':'s', '!':'i', '|':'i', '+':'t'
  };
  var WORD_CHAR = /[A-Za-z0-9@$!|+]/;
  var LETTER = /[A-Za-z]/;

  /* Deliberately broad, but exact-word matched with letter boundaries so
   * ordinary words like "class", "therapist", "Scunthorpe" and "peninsula"
   * are not censored. */
  var WORDS = new Set(`
    fuck fucks fucked fucker fuckers fucking fuckin fuk fukin fuking fuked fuker fukers
    fck fcks fcked fcker fckers fcking fcuk fcuking phuck phucks phucked phucker phuckers phucking
    fk fks fked fker fkers fking fkface fkyou fkoff fkup
    fvck fvcks fvcked fvcker fvckers fvcking fack facks facked facker fackers facking
    fux fuxk fuxked fuxker fuxking fook fooking fooked fooker fookers feck fecking fecked fecker
    fuckface fuckfaces fuckhead fuckheads fuckwit fuckwits fucktard fucktards fuckup fuckups
    fuckboy fuckboys fuckboi fuckbois fucknut fucknuts fucknugget fucknuggets fuckstick fucksticks
    fucktoy fucktoys fuckyou fuckoff fuckall fuckery fuckeries fuckable fuckwad fuckwads
    fuckfest fuckfests fuckmachine unfuck unfucked unfucking motherfuck motherfucks motherfucked
    motherfucker motherfuckers motherfucking clusterfuck clusterfucks
    shit shits shitty shitting shithead shitheads shitface shitstain shitstains shitbag shitbags
    sht shts shty shting shthead shtheads shtface shtstain shtbag shtbags
    shitshow shitshows shitstorm shitstorms shitlord shitlords dipshit dipshits bullshit bullshits
    bullshitting horseshit horseshits
    bitch bitches bitching bitchy bitchass bitchface sonofabitch sonofabitches
    btch btchs btching btchy btchass btchface sonofabtch bch bchs
    asshole assholes asshat asshats asswipe asswipes assclown assclowns asskisser asskissers
    asslicker asslickers assbag assbags assface assfaces dumbass dumbasses jackass jackasses
    smartass smartasses fatass fatasses badass badasses ahole aholes
    cunt cunts cunty cuntface cuntfaced cnt cnts cnty cntface
    dick dicks dickhead dickheads dickwad dickwads dickface dickfaces dickhole dickholes
    dck dcks dckhead dckheads dckwad dckwads dckface dckhole
    cock cocks cocksucker cocksuckers cockhead cockheads cockface cockfaces
    cck ccks ccksucker ccksuckers
    pussy pussies pussyface pssy pssies
    whore whores whoring whorehouse whorehouses whre whres
    slut sluts slutty sluttier sluttish slt slts slty
    bastard bastards bastardize bastardized
    douche douches douchebag douchebags douchey
    prick pricks prickface
    twat twats twatty
    wank wanks wanked wanker wankers wanking
    tosser tossers tosspot tosspots
    arse arses arsehole arseholes
    bollock bollocks bollocking
    bugger buggers buggered buggering
    bellend bellends
    knobhead knobheads
    skank skanks skanky
    slag slags slaggy
    thot thots
    hoe hoes
    bimbo bimbos
    incel incels
    cuck cucks cuckold cuckolds
    libtard libtards feminazi feminazis
    scumbag scumbags
    spastic spastics spaz spazz
    retard retards retarded retardation retardate retardates
    moron morons moronic imbecile imbeciles imbecilic idiot idiots idiotic
    nazi nazis nazism nzi nzis hitler hitlers htler swastika swastikas
    kkk kukluxklan heilhitler siegheil whitepower whitepride racewar racewars
    fag fags fagot fagots faggot faggots faggotry fggot fggots
    dyke dykes tranny trannies shemale shemales homo homos
    nigger niggers nigga niggas nignog nignogs negro negros ngger nggers ngga nggas
    coon coons spic spics spick spicks chink chinks chnk chnks gook gooks kike kikes kke kkes
    paki pakis raghead ragheads towelhead towelheads wetback wetbacks beaner beaners
    redskin redskins injun injuns squaw squaws cameljockey cameljockeys sandnigger sandniggers
    porn porno pornos prn prno pornography pornographic pornstar pornstars
    sex sexes sexy sext sexting sexts sexual
    penis penises pnis pnises vagina vaginas vginas vaginal
    tits titties titty boob boobs boobies nipple nipples
    cum cums cumming cumshot cumshots jizz jizzes semen
    blowjob blowjobs handjob handjobs rimjob rimjobs footjob footjobs
    dildo dildos vibrator vibrators
    orgasm orgasms orgasmic orgy orgies
    masturbate masturbates masturbating masturbation
    ejaculate ejaculates ejaculation
    creampie creampies
    hentai
    loli lolicon shotacon
    pedo pedos pedophile pedophiles pedophilia paedo paedos paedophile paedophiles paedophilia
    childporn childporno childpornography
    bestiality zoophile zoophiles zoophilia
    necrophilia necrophile necrophiles
    incest incestuous
    molest molests molested molester molesters molestation
    rape rapes raped raping rapist rapists rpe rpes rped rping rpist rpists
    sodomy sodomize sodomized sodomite sodomites
    nude nudes nudity
    kys kms killyourself killurself godie
    damn dammit damned
    crap craps crappy
    piss pissed pissing pisser pissers pissoff
    puta putas puto putos mierda cabron cabrona pendejo pendeja pendejos pendejas
    chingar chingada joder jodete verga culero culiao zorra
    merde putain salope connard connasse encule enculer batard chier chienne
    scheisse scheiss arschloch arsch wichser ficker hurensohn hure huren schwuchtel fotze
    kanker klootzak tering
    caralho foda foder
    cazzo stronzo puttana merda vaffanculo
    blyat blyad pizda pidor mudak govno
    bhosdi bhosdike chutiya chutiye madarchod behenchod bhenchod gandu gaandu
    putangina putanginamo
    sharmouta sharmuta
  `.trim().split(/\s+/));

  function collapse(word) {
    return word.replace(/(.)\1+/g, '$1');
  }

  /* Collapsed versions of the list catch "fuuuck" / "puuussy".  Very short
   * collapsed forms are skipped: collapsing "coon"/"boob" would produce the
   * ordinary words "con"/"bob", and collapsing "kkk" would produce "k". */
  var COLLAPSED = new Set();
  WORDS.forEach(function (word) {
    var c = collapse(word);
    if (c.length >= 4) COLLAPSED.add(c);
  });

  function norm(text, strip) {
    var out = '';
    var map = [];
    var groups = [];
    var groupFirst = [];
    var groupLast = [];

    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i).toLowerCase();
      if (!WORD_CHAR.test(c)) continue;          // space/punctuation separator

      var n;
      if (strip) {
        if (c >= '0' && c <= '9') continue;      // "fu2ck" -> "fuck"
        if ('@$!|+'.indexOf(c) >= 0) continue;   // "f@ck" -> "fck"
        n = c;
      } else {
        n = LEET[c] || c;
        if (!n) continue;
      }

      out += n;
      map.push(i);

      if (groups.length && groups[groups.length - 1] === n) {
        groupLast[groupLast.length - 1] = i;
      } else {
        groups.push(n);
        groupFirst.push(i);
        groupLast.push(i);
      }
    }

    return {
      s: out,
      map: map,
      gs: groups.join(''),
      gf: groupFirst,
      gl: groupLast
    };
  }

  function startOK(text, first) {
    /* Digits/symbols before the match are filler ("2fuck"); a letter means
     * the match starts inside a real word ("Scunthorpe"). */
    return first <= 0 || !LETTER.test(text.charAt(first - 1));
  }

  function endOK(text, last) {
    /* A following letter means this is a prefix of a real word
     * ("peninsula", "therapist"); digits/symbols/punctuation are filler. */
    return last + 1 >= text.length || !LETTER.test(text.charAt(last + 1));
  }

  function addMatch(text, first, last, spans) {
    if (first == null || last == null || first > last) return;
    if (!startOK(text, first) || !endOK(text, last)) return;
    spans.push([first, last]);
  }

  function scanFlat(normed, words, text, spans) {
    var s = normed.s;
    for (var word of words) {
      var from = 0;
      while (from < s.length) {
        var at = s.indexOf(word, from);
        if (at < 0) break;
        addMatch(text, normed.map[at], normed.map[at + word.length - 1], spans);
        from = at + 1;
      }
    }
  }

  function scanCollapsed(normed, words, text, spans) {
    var s = normed.gs;
    for (var word of words) {
      var from = 0;
      while (from < s.length) {
        var at = s.indexOf(word, from);
        if (at < 0) break;
        addMatch(text, normed.gf[at], normed.gl[at + word.length - 1], spans);
        from = at + 1;
      }
    }
  }

  function maskWords(text) {
    var raw = String(text == null ? '' : text);
    var spans = [];
    var leet = norm(raw, false);
    var strip = norm(raw, true);

    scanFlat(leet, WORDS, raw, spans);
    scanFlat(strip, WORDS, raw, spans);
    scanCollapsed(leet, COLLAPSED, raw, spans);
    scanCollapsed(strip, COLLAPSED, raw, spans);

    if (!spans.length) return raw;

    var out = raw.split('');
    var marked = new Set();
    for (var span of spans) {
      for (var i = span[0]; i <= span[1]; i++) {
        if (WORD_CHAR.test(raw.charAt(i))) marked.add(i);
      }
    }
    for (var at of marked) out[at] = '#';
    return out.join('');
  }

  function clean(value) {
    var raw = String(value == null ? '' : value);
    if (!raw) return { ok: false, error: 'Message is empty.' };
    if (/[^\x20-\x7E]/.test(raw)) {
      return { ok: false, error: 'Chat is ASCII only: no Unicode or emoji.' };
    }
    var text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, error: 'Message is empty.' };
    if (text.length > MAX) {
      return { ok: false, error: 'Chat is limited to ' + MAX + ' characters.' };
    }
    if (new RegExp('(.)\\1{' + MAX_REPEAT + ',}').test(text)) {
      return { ok: false, error: 'Too many repeated characters.' };
    }
    return { ok: true, text: maskWords(text) };
  }

  window.RBLXchatfilter = {
    clean: clean,
    mask: maskWords,
    MAX: MAX
  };
})();

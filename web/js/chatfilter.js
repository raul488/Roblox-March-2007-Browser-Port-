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
    fk fks fked fker fkers fking fkface fkyou fkoff fkup fkn fkr fkrs
    fukn fukr fukrs fckn fckr fckrs fuckn fuckr fuckrs
    fvck fvcks fvcked fvcker fvckers fvcking fack facks facked facker fackers facking
    fawk fawks fawked fawker fawkers fawking
    fux fuxk fuxked fuxker fuxking fook fooking fooked fooker fookers feck fecking fecked fecker
    fuckface fuckfaces fuckhead fuckheads fuckwit fuckwits fucktard fucktards fuckup fuckups fuckings
    fuckboy fuckboys fuckboi fuckbois fucknut fucknuts fucknugget fucknuggets fuckstick fucksticks
    fucktoy fucktoys fuckyou fuckoff fuckall fuckery fuckeries fuckable fuckwad fuckwads
    fuckfest fuckfests fuckmachine unfuck unfucked unfucking motherfuck motherfucks motherfucked
    motherfucker motherfuckers motherfucking clusterfuck clusterfucks
    shit shits shitty shitting shitted shithead shitheads shitface shitstain shitstains shitbag shitbags
    sht shts shty shting shthead shtheads shtface shtstain shtbag shtbags shtz
    shite shites shitey
    shitshow shitshows shitstorm shitstorms shitlord shitlords dipshit dipshits bullshit bullshits
    bullshitting horseshit horseshits
    bitch bitches bitching bitchy bitched bitchass bitchface sonofabitch sonofabitches
    btch btchs btching btchy btchass btchface sonofabtch bch bchs btchz
    ass asss
    asshole assholes asshat asshats asswipe asswipes assclown assclowns asskisser asskissers
    asslicker asslickers assbag assbags assface assfaces dumbass dumbasses jackass jackasses
    smartass smartasses fatass fatasses badass badasses ahole aholes kickass kickasses
    cunt cunts cunty cuntface cuntfaced cnt cnts cnty cntface cntz cunted cunting
    dick dicks dickhead dickheads dickwad dickwads dickface dickfaces dickhole dickholes
    dck dcks dckhead dckheads dckwad dckwads dckface dckhole dckz dicked dicking
    cock cocks cocksucker cocksuckers cockhead cockheads cockface cockfaces
    cck ccks ccksucker ccksuckers cocked cocking
    pussy pussies pussyface pssy pssies pssyz pussied pussying
    whore whores whoring whorehouse whorehouses whre whres whored
    slut sluts slutty sluttier sluttish slt slts slty slutted slutting
    bastard bastards bastardize bastardized bastardly
    douche douches douchebag douchebags douchey douching
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
    cuck cucks cuckold cuckolds cuckolding
    libtard libtards feminazi feminazis
    scumbag scumbags
    spastic spastics spaz spazz spazzy
    retard retards retarded retardation retardate retardates retarding
    moron morons moronic moronism imbecile imbeciles imbecilic imbecility idiot idiots idiotic idiotically
    nazi nazis nazism nzi nzis nazify nazifies nazified nazifying nazification hitler hitlers htler hitlerian swastika swastikas
    kkk kukluxklan heilhitler siegheil whitepower whitepride racewar racewars
    fag fags fagz fagot fagots faggot faggots faggotry fggot fggots fagged fagging faggy faggoty faggoting
    dyke dykes dykey tranny trannies trannie shemale shemales homo homos
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
    dildo dildos dildoes vibrator vibrators
    orgasm orgasms orgasmic orgy orgies
    masturbate masturbates masturbating masturbation masturbated
    ejaculate ejaculates ejaculation ejaculated ejaculating ejaculations
    creampie creampies
    hentai
    loli lolicon shotacon
    pedo pedos pedophile pedophiles pedophilia pedophilic pedophiliac pedophiliacs paedo paedos paedophile paedophiles paedophilia paedophilic paedophiliac paedophiliacs
    childporn childporno childpornography
    bestiality zoophile zoophiles zoophilia zoophilic zoophiliac zoophiliacs
    necrophilia necrophile necrophiles necrophilic necrophiliac necrophiliacs
    incest incestuous
    molest molests molested molester molesters molestation molesting
    rape rapes raped raping rapist rapists rpe rpes rped rping rpist rpists
    sodomy sodomize sodomized sodomite sodomites sodomizing
    nude nudes nudity
    kys kms killyourself killurself godie
    damn dammit damned
    crap craps crappy
    piss pissed pissing pisser pissers pissoff
    puta putas puto putos mierda cabron cabrona pendejo pendeja pendejos pendejas
    chingar chingada joder jodete verga culero culiao zorra hijodeputa hijodeputo hijueputa
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

  /* Safe collision words are generated from the public-domain words_alpha
   * dictionary (see safewords.js): dictionary words at Damerau-Levenshtein
   * distance 1 from a banned word.  They are used only to suppress the
   * fuzzy pass, never to suppress an exact match.  The source dictionary
   * is fetched once at build time; this file embeds the result. */
  var SAFE = new Set();
  var safeSource = (typeof window !== 'undefined' && window.RBLX_SAFE_WORDS) || '';
  if (safeSource) {
    for (var safeWord of safeSource.split(/\s+/)) {
      if (safeWord) SAFE.add(safeWord);
    }
  }
  var FUZZY_WORDS = [];
  WORDS.forEach(function (word) {
    if (/^[a-z]+$/.test(word) && word.length >= 4) FUZZY_WORDS.push(word);
  });

  /* OSA distance <= 1: one insert, delete, substitute, or adjacent swap. */
  function withinOne(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    var i = 0;
    if (a.length === b.length) {
      while (i < a.length && a.charAt(i) === b.charAt(i)) i++;
      if (i === a.length) return true;
      if (a.slice(i + 1) === b.slice(i + 1)) return true;          // substitution
      if (i + 1 < a.length && a.charAt(i) === b.charAt(i + 1) &&
          a.charAt(i + 1) === b.charAt(i)) {
        return a.slice(i + 2) === b.slice(i + 2);                  // transposition
      }
      return false;
    }
    var longer = a.length > b.length ? a : b;
    var shorter = a.length > b.length ? b : a;
    while (i < shorter.length && longer.charAt(i) === shorter.charAt(i)) i++;
    return longer.slice(i + 1) === shorter.slice(i);               // one insertion
  }

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

  /* A star/punctuation gap can erase too many letters for the normalized
   * forms to recover ("s**t" becomes "st"). These are the common short
   * stems that cannot be in the word list without matching ordinary
   * two-letter words. */
  var GAP = [
    /f\W+k(?![A-Za-z])/gi,
    /s\W+t(?![A-Za-z])/gi,
    /b\W+ch(?![A-Za-z])/gi,
    /c\W+nt(?![A-Za-z])/gi,
    /c\W+t(?![A-Za-z])/gi,
    /d\W+ck(?![A-Za-z])/gi,
    /d\W+k(?![A-Za-z])/gi,
    /p\W{2,}y(?![A-Za-z])/gi,
    /n\W+er(?![A-Za-z])/gi,
    /n\W+ger(?![A-Za-z])/gi,
    /f\W+got(?![A-Za-z])/gi,
    /k\W+ke(?![A-Za-z])/gi,
    /sp\W+c(?![A-Za-z])/gi,
    /g\W{2,}k(?![A-Za-z])/gi
  ];

  function scanGaps(text, spans) {
    for (var re of GAP) {
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(text))) {
        addMatch(text, m.index, m.index + m[0].length - 1, spans);
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }

  /* A conservative fuzzy pass for out-of-vocabulary tokens of five or more
   * letters.  Short words are already covered by the exact list and are
   * too collision-prone for edit distance (duck/luck/suck vs fuck). */
  var TOKEN_RE = /[A-Za-z0-9@$!|+]+/g;

  function scanFuzzy(text, spans) {
    if (!FUZZY_WORDS.length) return;
    TOKEN_RE.lastIndex = 0;
    var m;
    while ((m = TOKEN_RE.exec(text))) {
      var token = m[0], first = m.index, last = first + token.length - 1;
      var forms = [];
      var f1 = norm(token, false).s;
      var f2 = norm(token, true).s;
      if (f1 && forms.indexOf(f1) < 0) forms.push(f1);
      if (f2 && forms.indexOf(f2) < 0) forms.push(f2);

      var safe = false;
      for (var form of forms) {
        if (SAFE.has(form)) { safe = true; break; }
      }
      if (safe) continue;

      var hit = false;
      for (var form2 of forms) {
        if (form2.length < 5 || form2.length > 20) continue;
        for (var bad of FUZZY_WORDS) {
          if (Math.abs(bad.length - form2.length) > 1) continue;
          if (withinOne(form2, bad)) { hit = true; break; }
        }
        if (hit) break;
      }
      if (hit) spans.push([first, last]);
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
    scanGaps(raw, spans);
    scanFuzzy(raw, spans);

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
    MAX: MAX,
    words: Array.from(WORDS)
  };
})();

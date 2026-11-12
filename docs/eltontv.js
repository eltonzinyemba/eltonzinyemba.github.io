/*
 * EltonTV / CineSrc for Lampa - 2.4.0 (Samsung TV remote edition)
 *
 * Full-viewport CineSrc iframe driven through CineSrc's postMessage API.
 * While the player is open every remote key is handled here and none reach
 * Lampa, so no action can fire twice.
 *
 * Remote:
 *   OK / Play-Pause       toggle playback
 *   Play, Pause           play, pause
 *   Left/Right, Rew/FF    -/+10 s (quick presses add up into one seek)
 *   Up / Down             open the player menu
 *   CH+ / CH-             next / previous episode
 *   Back                  close the menu, then return to Lampa
 *   Stop                  return to Lampa
 * The TV's own volume keys stay with the TV.
 *
 * Player menu: next / previous episode, episode list, subtitles, speed,
 * player volume, restart, CineSrc's own controls (mouse), diagnostics.
 *
 * Also: season/episode picker with "Continue", resume where you stopped,
 * next episode starts by itself after a countdown you can cancel.
 *
 * WHAT CINESRC CAN BE TOLD (checked on a TV with Diagnostics):
 *   play, pause, seek, setVolume, getPaused, getCurrentTime, getDuration,
 *   getVolume, getMuted, getPlaybackRate. Nothing else: it has no commands
 *   for subtitles, quality, audio tracks or servers. So:
 *   - SUBTITLES are drawn by this plugin itself. It downloads subtitle files
 *     for the title and shows each line at the position CineSrc reports.
 *     They are independent of CineSrc's own subtitles, which this plugin
 *     cannot switch on or off.
 *   - QUALITY, AUDIO TRACK and SERVER can only be changed in CineSrc's own
 *     controls, which need a mouse (menu: "CineSrc's own controls").
 */
(function () {
    'use strict';

    if (window.eltontv_cinesrc_remote_240) return;
    window.eltontv_cinesrc_remote_240 = true;

    var ORIGIN = 'https://cinesrc.st';
    var CONTROLLER = 'eltontv_cinesrc_remote';
    var EPISODE_KEY = 'eltontv_cinesrc_last_episode';
    var PROGRESS_KEY = 'eltontv_cinesrc_progress';
    var SUBS_KEY = 'eltontv_cinesrc_subtitles';

    var SHOW_OSD = true;
    var OSD_MS = 2500;             // OSD stays this long after a key press
    var SEEK_STEP = 10;            // seconds per Left/Right press
    var VOLUME_STEP = 0.1;
    var SEEK_DEBOUNCE_MS = 400;    // presses closer than this become one seek
    var SEEK_HOLD_MS = 2000;       // ignore stale timeupdates after a seek
    var REQUEST_TIMEOUT_MS = 2500; // give up on an unanswered get* request
    var MENU_IDLE_MS = 20000;      // menu closes itself after this
    var AUTO_NEXT = true;          // start the next episode when one ends
    var AUTO_NEXT_SECONDS = 10;
    var RESUME = true;             // continue where you stopped
    var RESUME_MIN = 30;           // ...unless that was in the first 30 s
    var RESUME_END_GAP = 90;       // ...or the last 90 s (counts as finished)
    var SAVE_EVERY_MS = 15000;
    var PROGRESS_LIMIT = 300;      // remembered titles/episodes
    var POINTER_FOCUS_MS = 5000;   // pointer mode: remote works again this long after a click
    var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

    /* ---- the plugin's own subtitles ---- */
    var SUBTITLES = true;          // false removes the feature
    // Source 1, no account needed: the OpenSubtitles add-on that Stremio
    // publishes. It is asked by IMDb id, which Lampa's title data carries.
    var STREMIO_SUBS = 'https://opensubtitles-v3.strem.io';
    // Source 2, optional: Wyzie Subs. Needs a free key from
    // https://sub.wyzie.io/redeem - paste it between the quotes to switch
    // this source on. It is used when source 1 finds nothing.
    var WYZIE_SUBS = 'https://sub.wyzie.io';
    var WYZIE_KEY = '';
    var SUB_SIZES = [['Small', 3.8], ['Normal', 4.8], ['Large', 6]]; // name, % of screen height
    var SUB_DELAY_STEP = 0.25;     // seconds per Left/Right press on Timing
    var SUB_VERSIONS = 10;         // files kept per language
    var SUB_TICK_MS = 100;
    var HTTP_TIMEOUT_MS = 12000;

    // Name:codes. The codes are what the two sources use for a language.
    var LANGUAGES = ('English:en,eng|Spanish:es,spa|Spanish (Latin America):ea,spl|Spanish (Spain):sp,spn|' +
        'French:fr,fre,fra|German:de,ger,deu|Italian:it,ita|Portuguese:pt,por|' +
        'Portuguese (Brazil):pb,pob,pt-br|Russian:ru,rus|Ukrainian:uk,ukr|Polish:pl,pol|Dutch:nl,dut,nld|' +
        'Swedish:sv,swe|Danish:da,dan|Norwegian:no,nor,nb,nob|Finnish:fi,fin|Czech:cs,cze,ces|' +
        'Slovak:sk,slo,slk|Hungarian:hu,hun|Romanian:ro,rum,ron|Bulgarian:bg,bul|Greek:el,gre,ell|' +
        'Turkish:tr,tur|Arabic:ar,ara|Hebrew:he,heb|Persian:fa,per,fas|Hindi:hi,hin|Indonesian:id,ind|' +
        'Malay:ms,may,msa|Vietnamese:vi,vie|Thai:th,tha|Korean:ko,kor|Japanese:ja,jpn|Chinese:zh,chi,zho|' +
        'Chinese (Traditional):zt,zht,zh-tw|Chinese (bilingual):ze,zhe|Croatian:hr,hrv|Serbian:sr,scc,srp|' +
        'Slovenian:sl,slv|Bosnian:bs,bos|Macedonian:mk,mac,mkd|Albanian:sq,alb,sqi|Estonian:et,est|' +
        'Latvian:lv,lav|Lithuanian:lt,lit|Icelandic:is,ice,isl|Catalan:ca,cat|Basque:eu,baq,eus|' +
        'Galician:gl,glg|Bengali:bn,ben|Tamil:ta,tam|Telugu:te,tel|Malayalam:ml,mal|Urdu:ur,urd|' +
        'Georgian:ka,geo,kat|Armenian:hy,arm,hye|Azerbaijani:az,aze|Kazakh:kk,kaz|Sinhala:si,sin|' +
        'Tagalog:tl,tgl|Burmese:my,bur,mya|Mongolian:mn,mon|Khmer:km,khm|Swahili:sw,swa|' +
        'Afrikaans:af,afr|Montenegrin:me,mne|Belarusian:be,bel|Welsh:cy,wel,cym|Irish:ga,gle').split('|');

    // Older subtitle files are not always UTF-8; this is the usual encoding
    // for each language when a file is not.
    var LEGACY_ENCODINGS = [
        ['windows-1250', ['Polish', 'Czech', 'Slovak', 'Hungarian', 'Croatian', 'Slovenian', 'Romanian',
            'Bosnian', 'Albanian', 'Montenegrin']],
        ['windows-1251', ['Russian', 'Ukrainian', 'Bulgarian', 'Serbian', 'Macedonian', 'Belarusian',
            'Kazakh', 'Mongolian']],
        ['windows-1253', ['Greek']],
        ['windows-1254', ['Turkish', 'Azerbaijani']],
        ['windows-1255', ['Hebrew']],
        ['windows-1256', ['Arabic', 'Persian', 'Urdu']],
        ['windows-1257', ['Estonian', 'Latvian', 'Lithuanian']],
        ['windows-1258', ['Vietnamese']],
        ['windows-874', ['Thai']],
        ['gb18030', ['Chinese', 'Chinese (bilingual)']],
        ['big5', ['Chinese (Traditional)']],
        ['shift_jis', ['Japanese']],
        ['euc-kr', ['Korean']]
    ];

    var FLEX_ROW = 'display:-webkit-box;display:-webkit-flex;display:flex;' +
        '-webkit-box-pack:justify;-webkit-justify-content:space-between;justify-content:space-between;';
    var ROW_CSS = FLEX_ROW + '-webkit-box-align:center;-webkit-align-items:center;align-items:center;' +
        'padding:1.5vh 1.6vh;margin-bottom:0.4vh;border-radius:0.8vh;';
    var ROW_STACKED_CSS = 'display:block;padding:1.5vh 1.6vh;margin-bottom:0.4vh;border-radius:0.8vh;';
    var VALUE_CSS = 'opacity:0.7;margin-left:2vh;text-align:right;';
    var VALUE_STACKED_CSS = 'display:block;margin-top:0.4vh;word-wrap:break-word;';
    var LABEL_STACKED_CSS = 'display:block;opacity:0.7;font-size:2.1vh;';
    var DETAIL_CSS = 'font-size:2.1vh;';
    var DOT_CSS = 'display:inline-block;width:1.1vh;height:1.1vh;margin-right:1.4vh;' +
        'border-radius:50%;background:currentColor;vertical-align:middle;';

    /* ---------- state ---------- */

    var overlay = null;
    var iframe = null;
    var osdBox = null;
    var osdLabel = null;
    var osdValue = null;
    var osdBar = null;
    var osdHint = null;
    var menuBox = null;
    var menuTitle = null;
    var menuList = null;
    var subBox = null;
    var initialized = false;
    var swallowCode = 0;           // key that closed the player...
    var swallowUntil = 0;          // ...its repeats/key-up are hidden from Lampa
    var languageByCode = null;

    // What is open (set by openPlayer).
    var media = null;
    var series = false;
    var season = 0;
    var episode = 0;
    var seasons = [];
    var returnController = 'content';
    var previousOverflow = '';
    var lampaScreensaverWas = false;
    var pointerMode = false;       // iframe accepts the pointer
    var nativeControls = false;    // current page was loaded with CineSrc's own controls
    var menu = null;               // null, or a stack of menu levels
    var menuTimer = null;
    var focusTimer = null;
    var subPrefs = { lang: '', size: 1, top: false, titles: {} };

    // Per page load of the iframe (reset by resetLoad).
    var ready, paused, time, timeAt, duration, volume, speed, sourceId;
    var seekTarget, seekDelta, seekTimer, seekHoldUntil, pendingSeek;
    var pendingToggle, pendingVolume, inflight, osdTimer;
    var resumeAt, finished, lastSaveAt, userPauseAt, countdown, diag;

    // Subtitles for the current title or episode (reset by resetSubtitles).
    var subStatus = '';            // '', 'loading', 'ready', 'none', 'error'
    var subLangs = [];             // [{ name, files: [{ lang, url }] }]
    var subLang = '';              // language being shown, '' = off
    var subPick = 0;               // which file of that language
    var subCues = [];
    var subDelay = 0;              // seconds; positive = subtitles later
    var subShown = '';
    var subTimer = null;
    var subToken = 0;              // invalidates late answers
    var subFileToken = 0;
    var subNotes = [];             // what each source said, for Diagnostics

    function clearLoadTimers() {
        var key;
        if (seekTimer) clearTimeout(seekTimer);
        if (osdTimer) clearTimeout(osdTimer);
        if (countdown && countdown.timer) clearInterval(countdown.timer);
        if (inflight) {
            for (key in inflight) {
                if (inflight[key]) clearTimeout(inflight[key]);
            }
        }
    }

    function resetLoad() {
        clearLoadTimers();
        ready = false;
        paused = null;          // null = unknown
        time = null;
        timeAt = 0;             // when `time` was last reported
        duration = null;
        volume = null;          // 0..1, null = unknown
        speed = null;           // playback rate, null = unknown
        sourceId = '';          // CineSrc's name for the server in use
        seekTarget = null;
        seekDelta = 0;
        seekTimer = null;
        seekHoldUntil = 0;
        pendingSeek = 0;
        pendingToggle = false;
        pendingVolume = 0;
        inflight = {};
        osdTimer = null;
        resumeAt = null;        // position to jump to once the video is loaded
        finished = false;
        lastSaveAt = 0;
        userPauseAt = 0;
        countdown = null;
        diag = { types: {}, last: {}, asked: {}, answered: {}, results: {}, foreign: '' };
    }
    resetLoad();

    /* ---------- helpers ---------- */

    function notify(message) {
        if (window.Lampa && Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
    }

    function num(value) {
        return typeof value === 'number' && isFinite(value);
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    // Short JSON of a message, without the fields named in `skip`.
    function compact(data, skip) {
        var copy = data;
        var text, key;
        if (data && typeof data === 'object' && !isArray(data) && skip) {
            copy = {};
            for (key in data) {
                if (skip.indexOf(key) < 0) copy[key] = data[key];
            }
        }
        try { text = JSON.stringify(copy); } catch (e) { text = String(copy); }
        if (text === undefined) text = 'nothing';
        return text.length > 300 ? text.slice(0, 300) + '...' : text;
    }

    function validTmdbId(id) {
        return /^\d+$/.test(String(id || ''));
    }

    function isSeries(movie) {
        return movie.media_type === 'tv' || movie.type === 'tv' ||
            !!movie.first_air_date || !!movie.number_of_seasons ||
            !!(movie.seasons && movie.seasons.length);
    }

    function positiveInt(value) {
        var n = Math.floor(Number(value));
        return isFinite(n) && n >= 1 ? n : 1;
    }

    function isOkKey(code) {
        return code === 13 || code === 32 || code === 10252 || code === 415;
    }

    function isBackKey(code) {
        return code === 10009 || code === 461 || code === 27 || code === 8;
    }

    function activeControllerName() {
        try {
            var active = Lampa.Controller.enabled && Lampa.Controller.enabled();
            if (typeof active === 'string') return active;
            if (active && active.name) return active.name;
        } catch (ignored) {}
        return 'content';
    }

    function pad(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function formatTime(seconds) {
        if (!num(seconds)) return '--:--';
        seconds = Math.max(0, Math.floor(seconds));
        var h = Math.floor(seconds / 3600);
        var m = Math.floor(seconds % 3600 / 60);
        var s = seconds % 60;
        return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
    }

    function seekBusy() {
        return seekTimer !== null || Date.now() < seekHoldUntil;
    }

    // Best known position: the seek target while a seek is pending or
    // settling, otherwise the last time the player reported.
    function position() {
        return seekBusy() && seekTarget !== null ? seekTarget : time;
    }

    function timeLabel() {
        return formatTime(position()) + (duration ? ' / ' + formatTime(duration) : '');
    }

    function progress() {
        var p = position();
        return duration && num(p) ? p / duration : 0;
    }

    function speedLabel(value) {
        return value === 1 ? 'Normal' : value + 'x';
    }

    function makeUrl() {
        var id = encodeURIComponent(String(media.id));
        var url = ORIGIN + '/embed/';
        if (series) url += 'tv/' + id + '?s=' + season + '&e=' + episode + '&';
        else url += 'movie/' + id + '?';
        return url + 'autoplay=true' + (nativeControls ? '' : '&controls=false') + '&back=close';
    }

    /* ---------- storage: last episode, resume position ---------- */

    function readMap(key) {
        try {
            var map = Lampa.Storage.get(key, '{}');
            if (typeof map === 'string') map = JSON.parse(map);
            return map && typeof map === 'object' ? map : {};
        } catch (e) {
            return {};
        }
    }

    function writeMap(key, map) {
        // true = don't announce the change to the rest of Lampa
        try { Lampa.Storage.set(key, map, true); } catch (ignored) {}
    }

    function loadLastEpisode(id) {
        var last = readMap(EPISODE_KEY)[id];
        return last && last.s >= 1 && last.e >= 1 ? last : null;
    }

    function saveLastEpisode(id, s, e) {
        var map = readMap(EPISODE_KEY);
        map[id] = { s: s, e: e };
        writeMap(EPISODE_KEY, map);
    }

    function progressId() {
        return series ? 't' + media.id + ':' + season + ':' + episode : 'm' + media.id;
    }

    function prune(map) {
        var keys = [];
        var key;
        for (key in map) keys.push(key);
        if (keys.length <= PROGRESS_LIMIT) return;
        keys.sort(function (a, b) { return (map[a].at || 0) - (map[b].at || 0); });
        while (keys.length > PROGRESS_LIMIT) delete map[keys.shift()];
    }

    function saveProgress() {
        if (!RESUME || !media || resumeAt !== null) return; // never overwrite before resuming
        var p = position();
        if (!num(p)) return;
        var map = readMap(PROGRESS_KEY);
        var id = progressId();
        if (finished || p < RESUME_MIN || (duration && p > duration - RESUME_END_GAP)) {
            if (!map[id]) return;
            delete map[id];
        } else {
            map[id] = { t: Math.floor(p), d: duration ? Math.floor(duration) : 0, at: Date.now() };
            prune(map);
        }
        writeMap(PROGRESS_KEY, map);
    }

    function tickSave() {
        if (Date.now() - lastSaveAt < SAVE_EVERY_MS) return;
        lastSaveAt = Date.now();
        saveProgress();
    }

    // Jump to the remembered position once the video is really loaded.
    function maybeResume() {
        if (resumeAt === null || (!duration && time === null)) return;
        var at = resumeAt;
        resumeAt = null;
        if (duration && at > duration - RESUME_END_GAP) return;
        seekTarget = at;
        time = at;
        timeAt = Date.now();
        seekHoldUntil = Date.now() + SEEK_HOLD_MS;
        send('seek', [at]);
        showPosition('Resumed');
    }

    /* ---------- episodes ---------- */

    function seasonList(movie) {
        var out = [];
        var list = movie.seasons || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].season_number > 0 && list[i].episode_count > 0) out.push(list[i]);
        }
        out.sort(function (a, b) { return a.season_number - b.season_number; });
        return out;
    }

    function seasonTitle(item) {
        return item.name || 'Season ' + item.season_number;
    }

    function findSeason(number) {
        for (var i = 0; i < seasons.length; i++) {
            if (seasons[i].season_number === number) return i;
        }
        return -1;
    }

    function episodeLabel(ep) {
        return 'S' + ep.s + ' E' + ep.e;
    }

    // The episode after (+1) or before (-1) the current one, or null.
    // sure = false when there is no season data to confirm it exists.
    function neighbour(step) {
        if (!series) return null;
        var i = findSeason(season);
        if (i < 0) {
            if (step > 0) return { s: season, e: episode + 1, sure: false };
            return episode > 1 ? { s: season, e: episode - 1, sure: false } : null;
        }
        if (step > 0) {
            if (episode < seasons[i].episode_count) return { s: season, e: episode + 1, sure: true };
            return i + 1 < seasons.length ? { s: seasons[i + 1].season_number, e: 1, sure: true } : null;
        }
        if (episode > 1) return { s: season, e: episode - 1, sure: true };
        return i > 0 ? { s: seasons[i - 1].season_number, e: seasons[i - 1].episode_count, sure: true } : null;
    }

    function goToEpisode(ep) {
        if (!overlay || !ep) return;
        saveProgress();
        season = ep.s;
        episode = ep.e;
        saveLastEpisode(media.id, season, episode);
        load();
    }

    function stepEpisode(step) {
        if (!series) return;
        var target = neighbour(step);
        if (target) goToEpisode(target);
        else osd(step > 0 ? 'Last episode' : 'First episode', '', 0);
    }

    function onEnded() {
        if (finished) return;
        finished = true;
        saveProgress(); // forgets the resume point
        var next = neighbour(1);
        if (next && next.sure) {
            saveLastEpisode(media.id, next.s, next.e); // "Continue" now means the next one
            if (AUTO_NEXT) startCountdown(next);
        }
    }

    function paintCountdown() {
        if (!osdBox || !countdown) return;
        if (osdTimer) {
            clearTimeout(osdTimer);
            osdTimer = null;
        }
        paintOsd('Next: ' + episodeLabel(countdown.next), 'in ' + countdown.left + ' s',
            1 - countdown.left / AUTO_NEXT_SECONDS, 'OK starts it now. Back cancels.');
        osdBox.style.opacity = '1';
    }

    function startCountdown(next) {
        cancelCountdown();
        countdown = { next: next, left: AUTO_NEXT_SECONDS, timer: null };
        countdown.timer = setInterval(function () {
            if (!countdown) return;
            countdown.left--;
            if (countdown.left <= 0) finishCountdown();
            else paintCountdown();
        }, 1000);
        paintCountdown();
    }

    function cancelCountdown() {
        if (!countdown) return;
        clearInterval(countdown.timer);
        countdown = null;
        settleOsd();
    }

    function finishCountdown() {
        var next = countdown && countdown.next;
        cancelCountdown();
        if (next) goToEpisode(next);
    }

    /* ---------- on-screen display ---------- */

    function buildOsd() {
        osdBox = document.createElement('div');
        osdBox.className = 'eltontv-osd';
        osdBox.style.cssText = 'position:absolute;left:4vh;bottom:4vh;width:46vh;max-width:80%;' +
            'box-sizing:border-box;padding:1.6vh 2.2vh 1.8vh;border-radius:0.8vh;' +
            'background:rgba(0,0,0,0.7);color:#fff;font:500 2.8vh/1.3 sans-serif;' +
            'pointer-events:none;opacity:0;-webkit-transition:opacity .2s;transition:opacity .2s;';

        var row = document.createElement('div');
        row.style.cssText = FLEX_ROW;
        osdLabel = document.createElement('span');
        osdValue = document.createElement('span');
        osdValue.style.cssText = 'opacity:0.75;margin-left:2vh;';
        row.appendChild(osdLabel);
        row.appendChild(osdValue);

        var track = document.createElement('div');
        track.style.cssText = 'margin-top:1.2vh;height:0.5vh;border-radius:0.25vh;' +
            'background:rgba(255,255,255,0.25);overflow:hidden;';
        osdBar = document.createElement('div');
        osdBar.style.cssText = 'width:0;height:100%;background:#fff;';
        track.appendChild(osdBar);

        osdHint = document.createElement('div');
        osdHint.style.cssText = 'display:none;margin-top:1vh;font-size:2.1vh;opacity:0.75;';

        osdBox.appendChild(row);
        osdBox.appendChild(track);
        osdBox.appendChild(osdHint);
        overlay.appendChild(osdBox);
    }

    function paintOsd(label, value, fraction, hint) {
        osdLabel.textContent = label;
        osdValue.textContent = value || '';
        osdBar.style.width = Math.max(0, Math.min(100, (fraction || 0) * 100)) + '%';
        osdHint.textContent = hint || '';
        osdHint.style.display = hint ? 'block' : 'none';
    }

    function osd(label, value, fraction, hint) {
        if (!osdBox) return;
        paintOsd(label, value, fraction, hint);
        osdBox.style.opacity = '1';
        if (osdTimer) clearTimeout(osdTimer);
        osdTimer = setTimeout(settleOsd, hint ? OSD_MS * 2 : OSD_MS); // hints take longer to read
    }

    // After a key press: hide, unless a countdown or a pause card should stay.
    function settleOsd() {
        osdTimer = null;
        if (!osdBox) return;
        if (countdown) paintCountdown();
        else if (paused === true) paintOsd('Paused', timeLabel(), progress());
        else osdBox.style.opacity = '0';
    }

    function showPosition(label) {
        osd(label, timeLabel(), progress());
    }

    /* ---------- CineSrc commands ---------- */

    function send(command, args) {
        if (!iframe || !iframe.contentWindow) return;
        try {
            iframe.contentWindow.postMessage({
                type: 'cinesrc:command',
                command: command,
                args: args || []
            }, ORIGIN);
        } catch (e) {
            if (window.console) console.warn('EltonTV CineSrc command:', e);
        }
    }

    // get* requests: one in flight per command, abandoned after a timeout so
    // a missing reply can never leave a key dead for the rest of the session.
    // force = ask again even if an earlier ask is still waiting (used when
    // the player says it is ready: anything sent before that was lost).
    function request(command, force) {
        if (inflight[command]) {
            if (!force) return;
            clearTimeout(inflight[command]);
        }
        diag.asked[command] = true;
        inflight[command] = setTimeout(function () {
            inflight[command] = null;
            requestFailed(command);
        }, REQUEST_TIMEOUT_MS);
        send(command);
    }

    function settle(command) {
        if (inflight[command]) clearTimeout(inflight[command]);
        inflight[command] = null;
    }

    function requestFailed(command) {
        if (command === 'getPaused' && pendingToggle) {
            // State still unknown. 'play' is harmless if it is already
            // playing, and the next OK press will then pause.
            pendingToggle = false;
            play();
        } else if (command === 'getCurrentTime') {
            pendingSeek = 0;
        } else if (command === 'getVolume') {
            pendingVolume = 0;
        }
    }

    // Ask the player for whatever is still unknown.
    function syncPlayer(force) {
        if (!ready) return;
        if (paused === null) request('getPaused', force);
        if (volume === null) request('getVolume', force);
        if (speed === null) request('getPlaybackRate', force);
        if (!duration) request('getDuration', force);
    }

    /* ---------- playback ---------- */

    function requireReady() {
        if (ready) return true;
        osd('Loading', '', 0);
        return false;
    }

    function play() {
        send('play');
        paused = false;
        showPosition('Playing');
    }

    function pause() {
        send('pause');
        paused = true;
        userPauseAt = Date.now();
        showPosition('Paused');
        saveProgress();
    }

    function togglePlayback() {
        if (!requireReady()) return;
        if (paused === null) {
            pendingToggle = true;
            request('getPaused');
        } else if (paused) {
            play();
        } else {
            pause();
        }
    }

    function seekBy(delta) {
        if (!requireReady()) return;
        var base = position();
        if (base === null) {
            pendingSeek += delta;
            request('getCurrentTime');
            return;
        }
        var target = Math.max(0, base + delta);
        if (duration) target = Math.min(Math.max(0, duration - 1), target);
        seekDelta += target - base;
        seekTarget = target;
        if (seekTimer) clearTimeout(seekTimer);
        seekTimer = setTimeout(commitSeek, SEEK_DEBOUNCE_MS);

        var size = Math.abs(Math.round(seekDelta));
        showPosition((seekDelta < 0 ? '-' : '+') + (size < 60 ? size + 's' : formatTime(size)));
    }

    function commitSeek() {
        seekTimer = null;
        seekDelta = 0;
        if (seekTarget === null) return;
        time = seekTarget;
        timeAt = Date.now();
        if (finished) {
            // Watching on after the end: "Continue" means this episode again.
            finished = false;
            if (series) saveLastEpisode(media.id, season, episode);
        }
        seekHoldUntil = Date.now() + SEEK_HOLD_MS;
        send('seek', [seekTarget]);
    }

    function restart() {
        closeMenu();
        if (!requireReady()) return;
        if (seekTimer) clearTimeout(seekTimer);
        seekTimer = null;
        seekDelta = 0;
        resumeAt = null;
        finished = false;
        seekTarget = 0;
        time = 0;
        timeAt = Date.now();
        seekHoldUntil = Date.now() + SEEK_HOLD_MS;
        send('seek', [0]);
        if (paused === true) play();
        else showPosition('From the start');
    }

    function setVolume(level) {
        volume = Math.round(Math.max(0, Math.min(1, level)) * 100) / 100;
        send('setVolume', [volume]);
        osd('Volume', Math.round(volume * 100) + '%', volume);
        refreshMenu();
    }

    function changeVolume(delta) {
        if (!requireReady()) return;
        if (volume === null) {
            pendingVolume += delta;
            request('getVolume');
        } else {
            setVolume(volume + delta);
        }
    }

    function setSpeed(value) {
        if (!requireReady()) return;
        send('setPlaybackRate', [value]);
        speed = value;
        osd('Speed', speedLabel(value), 0);
        // Ask the player what it actually switched to.
        setTimeout(function () {
            if (overlay && ready) request('getPlaybackRate');
        }, 800);
    }

    /* ---------- the plugin's own subtitles: finding and loading ---------- */

    function languageName(code) {
        var key = String(code || '').toLowerCase();
        var i, j, parts, codes;
        if (!languageByCode) {
            languageByCode = {};
            for (i = 0; i < LANGUAGES.length; i++) {
                parts = LANGUAGES[i].split(':');
                codes = parts[1].split(',');
                for (j = 0; j < codes.length; j++) languageByCode[codes[j]] = parts[0];
                languageByCode[parts[0].toLowerCase()] = parts[0];
            }
        }
        if (languageByCode[key]) return languageByCode[key];
        if (key.indexOf('-') > 0 && languageByCode[key.split('-')[0]]) return languageByCode[key.split('-')[0]];
        if (!key) return 'Unknown';
        // Not a code we know: show it as given (a full name, or the code in capitals).
        return key.length > 3 ? String(code) : key.toUpperCase();
    }

    function readSubPrefs() {
        var stored = readMap(SUBS_KEY);
        return {
            lang: typeof stored.lang === 'string' ? stored.lang : '',
            size: num(stored.size) && stored.size >= 0 && stored.size < SUB_SIZES.length ? stored.size : 1,
            top: stored.top === true,
            titles: stored.titles && typeof stored.titles === 'object' ? stored.titles : {}
        };
    }

    function saveSubPrefs() {
        writeMap(SUBS_KEY, subPrefs);
    }

    // Remember this title's file and timing, so they are back next time.
    function rememberSubtitleChoice() {
        subPrefs.titles[progressId()] = { l: subLang, p: subPick, d: subDelay, at: Date.now() };
        prune(subPrefs.titles);
        saveSubPrefs();
    }

    function subtitleNote(source, text) {
        subNotes.push(source + ': ' + text);
    }

    // GET a web address. binary = hand back the raw bytes when the TV can
    // decode them itself (needed for files that are not UTF-8).
    function http(url, binary, done) {
        var xhr;
        var settled = false;
        var raw = binary && typeof window.TextDecoder === 'function' && typeof window.Uint8Array === 'function';

        function finish(body, note) {
            if (settled) return;
            settled = true;
            done(body, note);
        }

        try {
            xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            if (raw) xhr.responseType = 'arraybuffer';
            xhr.timeout = HTTP_TIMEOUT_MS;
            xhr.onload = function () {
                var message = '';
                if (xhr.status >= 200 && xhr.status < 300) {
                    finish(raw ? xhr.response : xhr.responseText, 'ok');
                    return;
                }
                if (!raw) {
                    try { message = String(JSON.parse(xhr.responseText).message || ''); } catch (ignored) {}
                }
                finish(null, 'error ' + xhr.status + (message ? ' (' + message + ')' : ''));
            };
            xhr.onerror = function () { finish(null, 'could not connect'); };
            xhr.ontimeout = function () { finish(null, 'timed out'); };
            xhr.send();
        } catch (e) {
            finish(null, 'request failed');
        }
    }

    // Bytes to text: UTF-16 if marked, UTF-8 if valid, else the usual
    // encoding for the language.
    function decodeBytes(buffer, language) {
        var bytes = new window.Uint8Array(buffer);
        var name = 'windows-1252';
        var i;
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new window.TextDecoder('utf-16le').decode(bytes);
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new window.TextDecoder('utf-16be').decode(bytes);
        try {
            return new window.TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (notUtf8) {
            for (i = 0; i < LEGACY_ENCODINGS.length; i++) {
                if (LEGACY_ENCODINGS[i][1].indexOf(language) >= 0) name = LEGACY_ENCODINGS[i][0];
            }
            try { return new window.TextDecoder(name).decode(bytes); }
            catch (unknownEncoding) { return new window.TextDecoder('utf-8').decode(bytes); }
        }
    }

    function findImdbId(done) {
        var id = media.imdb_id || (media.external_ids && media.external_ids.imdb_id);
        var url;
        if (typeof id === 'string' && /^tt\d+$/.test(id)) {
            done(id);
            return;
        }
        // Not in the title data: ask TMDB the way Lampa does.
        try {
            url = Lampa.TMDB.api((series ? 'tv/' : 'movie/') + media.id + '/external_ids?api_key=' + Lampa.TMDB.key());
        } catch (e) {
            done(null);
            return;
        }
        http(url, false, function (body) {
            var data = null;
            try { data = JSON.parse(body); } catch (ignored) {}
            done(data && typeof data.imdb_id === 'string' && /^tt\d+$/.test(data.imdb_id) ? data.imdb_id : null);
        });
    }

    // done(files, reached): reached = the source answered at all.
    function fromStremio(imdb, done) {
        var id = imdb + (series ? ':' + season + ':' + episode : '');
        var url = STREMIO_SUBS + '/subtitles/' + (series ? 'series' : 'movie') + '/' +
            encodeURIComponent(id) + '.json';
        http(url, false, function (body, note) {
            var files = [];
            var data = null;
            var list, i;
            if (body !== null) {
                try { data = JSON.parse(body); } catch (e) { note = 'answer not understood'; }
            }
            list = data && isArray(data.subtitles) ? data.subtitles : [];
            for (i = 0; i < list.length; i++) {
                if (list[i] && typeof list[i].url === 'string') {
                    files.push({ lang: languageName(list[i].lang), url: list[i].url });
                }
            }
            subtitleNote('OpenSubtitles (Stremio)', data ? files.length + ' files' : note);
            done(files, !!data);
        });
    }

    function fromWyzie(done) {
        var url = WYZIE_SUBS + '/search?id=' + encodeURIComponent(String(media.id)) +
            (series ? '&season=' + season + '&episode=' + episode : '') +
            '&key=' + encodeURIComponent(WYZIE_KEY);
        http(url, false, function (body, note) {
            var files = [];
            var list = null;
            var i, item, link;
            if (body !== null) {
                try { list = JSON.parse(body); } catch (e) { note = 'answer not understood'; }
            }
            // Wyzie reports "nothing found" as an error with this message.
            if (body === null && /no subtitles|no matching/i.test(note)) list = [];
            if (!isArray(list)) {
                subtitleNote('Wyzie Subs', list ? 'answer not understood' : note);
                done([], false);
                return;
            }
            for (i = 0; i < list.length; i++) {
                item = list[i];
                if (!item || typeof item.url !== 'string') continue;
                // Ask Wyzie to hand every file over as SRT.
                link = item.url + (item.url.indexOf('?') < 0 ? '?' : '&') + 'to=srt';
                files.push({ lang: languageName(item.language || item.display), url: link });
            }
            subtitleNote('Wyzie Subs', files.length + ' files');
            done(files, true);
        });
    }

    function findSubtitleGroup(name) {
        for (var i = 0; i < subLangs.length; i++) {
            if (subLangs[i].name === name) return subLangs[i];
        }
        return null;
    }

    // Look for subtitle files for the current title or episode.
    function loadSubtitleList() {
        var token = ++subToken;
        var reachedAny = false;
        subStatus = 'loading';
        subNotes = [];
        refreshMenu();

        function finish(files) {
            var byName = {};
            var names = [];
            var i, name;
            if (token !== subToken || !overlay) return;
            for (i = 0; i < files.length; i++) {
                name = files[i].lang;
                if (!byName[name]) {
                    byName[name] = [];
                    names.push(name);
                }
                if (byName[name].length < SUB_VERSIONS) byName[name].push(files[i]);
            }
            names.sort();
            subLangs = [];
            for (i = 0; i < names.length; i++) subLangs.push({ name: names[i], files: byName[names[i]] });
            subStatus = subLangs.length ? 'ready' : (reachedAny ? 'none' : 'error');
            // Bring back the language chosen last time, if this title has it.
            if (subPrefs.lang && !subLang && findSubtitleGroup(subPrefs.lang)) useSubtitleLanguage(subPrefs.lang);
            refreshMenu();
        }

        function wyzie() {
            if (!WYZIE_KEY) {
                finish([]);
                return;
            }
            fromWyzie(function (files, reached) {
                reachedAny = reachedAny || reached;
                finish(files);
            });
        }

        findImdbId(function (imdb) {
            if (token !== subToken || !overlay) return;
            if (!imdb) {
                subtitleNote('OpenSubtitles (Stremio)', 'skipped, this title has no IMDb id');
                wyzie();
                return;
            }
            fromStremio(imdb, function (files, reached) {
                reachedAny = reachedAny || reached;
                if (files.length) finish(files);
                else wyzie();
            });
        });
    }

    /* ---------- the plugin's own subtitles: reading and drawing ---------- */

    function parseTimestamp(text) {
        var match = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(text);
        if (!match) return null;
        return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) +
            Number((match[4] + '00').slice(0, 3)) / 1000;
    }

    // SRT and WebVTT. Tags are dropped: lines are drawn as plain text.
    function parseSubtitles(text) {
        var cues = [];
        var blocks = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
        var i, j, lines, times, start, end, body;
        for (i = 0; i < blocks.length; i++) {
            lines = blocks[i].split('\n');
            for (j = 0; j < lines.length; j++) {
                if (lines[j].indexOf('-->') >= 0) break;
            }
            if (j === lines.length) continue;
            times = lines[j].split('-->');
            start = parseTimestamp(times[0]);
            end = parseTimestamp(times[1]);
            if (start === null || end === null) continue;
            body = lines.slice(j + 1).join('\n')
                .replace(/<[^>]*>/g, '')
                .replace(/\{\\[^}]*\}/g, '')
                .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
                .replace(/^\s+|\s+$/g, '');
            if (body) cues.push({ start: start, end: end, text: body });
        }
        cues.sort(function (a, b) { return a.start - b.start; });
        return cues;
    }

    // The text that belongs on screen at second t.
    function cueTextAt(t) {
        var low = 0;
        var high = subCues.length - 1;
        var out = [];
        var middle, i;
        while (low <= high) {
            middle = (low + high) >> 1;
            if (subCues[middle].start <= t) low = middle + 1;
            else high = middle - 1;
        }
        // `high` is the last line that has started; a few may overlap.
        for (i = Math.max(0, high - 4); i <= high; i++) {
            if (subCues[i].end > t) out.push(subCues[i].text);
        }
        return out.join('\n');
    }

    // CineSrc reports the position about four times a second; between
    // reports the clock is carried forward so lines appear on time.
    function subtitleTime() {
        var base = position();
        if (!num(base)) return null;
        if (paused !== true && !seekBusy() && timeAt) {
            base += Math.min(1.5, (Date.now() - timeAt) / 1000) * (speed || 1);
        }
        return base;
    }

    function drawSubtitles() {
        var t, text;
        if (!subBox) return;
        t = subCues.length ? subtitleTime() : null;
        text = t === null ? '' : cueTextAt(t - subDelay);
        if (text === subShown) return;
        subShown = text;
        subBox.textContent = text;
    }

    function styleSubtitles() {
        if (!subBox) return;
        subBox.style.fontSize = SUB_SIZES[subPrefs.size][1] + 'vh';
        subBox.style.top = subPrefs.top ? '6vh' : 'auto';
        subBox.style.bottom = subPrefs.top ? 'auto' : '10vh';
    }

    function buildSubtitleBox() {
        subBox = document.createElement('div');
        subBox.className = 'eltontv-subs';
        subBox.style.cssText = 'position:absolute;left:8%;right:8%;text-align:center;pointer-events:none;' +
            'color:#fff;font-family:sans-serif;font-weight:600;line-height:1.3;white-space:pre-line;' +
            'text-shadow:0 0 0.5vh #000,0 0 0.5vh #000,0.15vh 0.15vh 0.2vh #000,-0.15vh -0.15vh 0.2vh #000;';
        overlay.appendChild(subBox);
        styleSubtitles();
    }

    function stopSubtitleFile() {
        subFileToken++;
        if (subTimer) clearInterval(subTimer);
        subTimer = null;
        subCues = [];
        subShown = '';
        if (subBox) subBox.textContent = '';
    }

    function resetSubtitles() {
        subToken++;
        stopSubtitleFile();
        subStatus = '';
        subLangs = [];
        subLang = '';
        subPick = 0;
        subDelay = 0;
        subNotes = [];
    }

    function loadSubtitleFile() {
        var group = findSubtitleGroup(subLang);
        var token, file, count;
        stopSubtitleFile();
        if (!group) {
            refreshMenu();
            return;
        }
        count = group.files.length;
        if (subPick < 0 || subPick >= count) subPick = 0;
        file = group.files[subPick];
        token = subFileToken;
        osd('Subtitles', subLang + (count > 1 ? ' ' + (subPick + 1) + '/' + count : ''), 0);
        refreshMenu();

        http(file.url, true, function (body, note) {
            var text, cues;
            if (token !== subFileToken || !overlay) return;
            text = body === null ? '' : (typeof body === 'string' ? body : decodeBytes(body, subLang));
            cues = text ? parseSubtitles(text) : [];
            if (!cues.length) {
                subtitleNote(subLang + ' file ' + (subPick + 1), body === null ? note : 'not a subtitle file this plugin can read');
                osd('Subtitles', count > 1 ? 'this version failed, try another' : 'could not be loaded', 0);
                refreshMenu();
                return;
            }
            subCues = cues;
            subTimer = setInterval(drawSubtitles, SUB_TICK_MS);
            drawSubtitles();
            refreshMenu();
        });
    }

    // name = '' switches the plugin's subtitles off.
    function useSubtitleLanguage(name) {
        var memory = subPrefs.titles[progressId()];
        subLang = name;
        subPrefs.lang = name;
        saveSubPrefs();
        if (!name) {
            stopSubtitleFile();
            osd('Subtitles', 'Off', 0);
            refreshMenu();
            return;
        }
        // Same title and language as before: same file and timing as before.
        if (memory && memory.l === name) {
            subPick = num(memory.p) ? memory.p : 0;
            subDelay = num(memory.d) ? memory.d : 0;
        } else {
            subPick = 0;
            subDelay = 0;
        }
        loadSubtitleFile();
    }

    function subtitleSummary() {
        if (subStatus === 'loading') return 'searching';
        if (subLang) return subLang;
        if (subPrefs.lang && subStatus === 'error') return 'unavailable';
        if (subPrefs.lang && (subStatus === 'none' || subStatus === 'ready')) return 'no ' + subPrefs.lang;
        return 'Off';
    }

    function timingLabel() {
        if (!subDelay) return 'in sync';
        return Math.abs(subDelay).toFixed(2) + ' s ' + (subDelay > 0 ? 'later' : 'earlier');
    }

    /* ---------- player menu ---------- */

    function buildMenu() {
        menuBox = document.createElement('div');
        menuBox.className = 'eltontv-menu';
        menuBox.style.cssText = 'position:absolute;top:0;right:0;bottom:0;width:64vh;max-width:92%;' +
            'box-sizing:border-box;background:rgba(0,0,0,0.86);color:#fff;' +
            'font:500 2.6vh/1.3 sans-serif;display:none;pointer-events:none;';
        menuTitle = document.createElement('div');
        menuTitle.style.cssText = 'position:absolute;top:5vh;right:4.6vh;left:4.6vh;font-size:3.4vh;' +
            'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        menuList = document.createElement('div');
        menuList.style.cssText = 'position:absolute;top:13vh;right:3vh;bottom:4vh;left:3vh;overflow:hidden;';
        menuBox.appendChild(menuTitle);
        menuBox.appendChild(menuList);
        overlay.appendChild(menuBox);
    }

    function rowElement(item, focused) {
        var row = document.createElement('div');
        var label = document.createElement('span');
        var value, dot;
        row.className = 'eltontv-row';
        if (focused) row.setAttribute('data-focused', '1');
        row.style.cssText = (item.stacked ? ROW_STACKED_CSS : ROW_CSS) +
            (focused ? 'background:#fff;color:#000;' : '') +
            (item.disabled ? 'opacity:0.4;' : '');
        if (item.stacked) label.style.cssText = LABEL_STACKED_CSS + (focused ? 'opacity:1;' : '');
        if (typeof item.current === 'boolean') {
            dot = document.createElement('span');
            dot.style.cssText = DOT_CSS + (item.current ? '' : 'visibility:hidden;');
            label.appendChild(dot);
        }
        label.appendChild(document.createTextNode(item.label));
        row.appendChild(label);
        if (item.value) {
            value = document.createElement('span');
            value.style.cssText = (item.stacked ? VALUE_STACKED_CSS : VALUE_CSS) +
                (item.small ? DETAIL_CSS : '');
            value.textContent = item.value;
            row.appendChild(value);
        }
        return row;
    }

    function keepVisible(row) {
        var top = row.offsetTop;
        var bottom = top + row.offsetHeight;
        if (top < menuList.scrollTop) menuList.scrollTop = top;
        else if (bottom > menuList.scrollTop + menuList.clientHeight) {
            menuList.scrollTop = bottom - menuList.clientHeight;
        }
    }

    function renderMenu() {
        var level, items, i, scroll;
        if (!menu || !menu.length || !menuBox) return;
        level = menu[menu.length - 1];
        items = level.items = level.build();

        if (level.index < 0) {
            for (i = 0; i < items.length; i++) {
                if (items[i].current === true && !items[i].disabled) {
                    level.index = i;
                    break;
                }
            }
        }
        if (level.index < 0 || level.index >= items.length || items[level.index].disabled) {
            level.index = -1;
            for (i = 0; i < items.length; i++) {
                if (!items[i].disabled) {
                    level.index = i;
                    break;
                }
            }
        }

        scroll = menuList.scrollTop;
        menuTitle.textContent = level.title;
        while (menuList.firstChild) menuList.removeChild(menuList.firstChild);
        for (i = 0; i < items.length; i++) {
            menuList.appendChild(rowElement(items[i], i === level.index));
        }
        menuBox.style.display = 'block';
        menuList.scrollTop = scroll;
        if (level.index >= 0) keepVisible(menuList.childNodes[level.index]);
    }

    function refreshMenu() {
        if (menu) renderMenu();
    }

    function armMenuIdle() {
        if (menuTimer) clearTimeout(menuTimer);
        menuTimer = setTimeout(closeMenu, MENU_IDLE_MS);
    }

    function closeMenu() {
        if (menuTimer) clearTimeout(menuTimer);
        menuTimer = null;
        menu = null;
        if (menuBox) menuBox.style.display = 'none';
    }

    function pushLevel(title, build) {
        if (!menu) menu = [];
        menu.push({ title: title, build: build, index: -1, items: [] });
        if (menuList) menuList.scrollTop = 0;
        renderMenu();
    }

    function popLevel() {
        if (!menu) return;
        menu.pop();
        if (menu.length) renderMenu();
        else closeMenu();
    }

    function openMenu() {
        if (!menuBox || menu) return;
        pushLevel(media.title || media.name || 'Player', buildRoot);
        armMenuIdle();
        syncPlayer(false);
    }

    function moveFocus(step) {
        var level = menu[menu.length - 1];
        var i = level.index + step;
        while (i >= 0 && i < level.items.length && level.items[i].disabled) i += step;
        if (i < 0 || i >= level.items.length) return;
        level.index = i;
        renderMenu();
    }

    // Returns true when the key belonged to the menu.
    function menuKey(code, repeat) {
        var level = menu[menu.length - 1];
        var item = level.index >= 0 ? level.items[level.index] : null;
        if (code === 38) {
            moveFocus(-1);
        } else if (code === 40) {
            moveFocus(1);
        } else if (code === 37) {
            if (item && item.adjust) item.adjust(-1);
            else if (!repeat) popLevel();
        } else if (code === 39) {
            if (item && item.adjust) item.adjust(1);
        } else if (code === 13 || code === 32) {
            if (!repeat && item && !item.disabled && item.action) item.action();
        } else if (isBackKey(code)) {
            if (!repeat) popLevel();
        } else {
            return false;
        }
        return true;
    }

    function speedItem(value) {
        return {
            label: speedLabel(value),
            current: speed === value,
            action: function () {
                setSpeed(value);
                popLevel();
            }
        };
    }

    function buildSpeeds() {
        var items = [];
        for (var i = 0; i < SPEEDS.length; i++) items.push(speedItem(SPEEDS[i]));
        return items;
    }

    function subtitleLanguageItem(group) {
        return {
            label: group.name,
            value: group.files.length > 1 ? group.files.length + ' versions' : '',
            current: subLang === group.name,
            action: function () {
                useSubtitleLanguage(group.name);
                popLevel();
            }
        };
    }

    function buildSubtitleLanguages() {
        var items = [{
            label: 'Off',
            current: !subLang,
            action: function () {
                useSubtitleLanguage('');
                popLevel();
            }
        }];
        var i;
        if (subStatus === 'loading') {
            items.push({ label: 'Searching for subtitles', disabled: true });
        } else if (subStatus === 'error') {
            items.push({ label: 'The subtitle source could not be reached', disabled: true });
            items.push({ label: 'Try again', action: loadSubtitleList });
        } else if (subStatus === 'none') {
            items.push({ label: 'None found for this title', disabled: true });
        }
        for (i = 0; i < subLangs.length; i++) items.push(subtitleLanguageItem(subLangs[i]));
        return items;
    }

    function buildSubtitleMenu() {
        var group = findSubtitleGroup(subLang);
        var count = group ? group.files.length : 0;
        var active = !!group;
        return [
            {
                label: 'Language',
                value: subtitleSummary(),
                action: function () {
                    if (!subStatus) loadSubtitleList();
                    pushLevel('Subtitle language', buildSubtitleLanguages);
                }
            },
            {
                label: 'Version',
                value: active ? '< ' + (subPick + 1) + ' of ' + count + ' >' : '',
                disabled: count < 2,
                adjust: function (direction) {
                    subPick = (subPick + direction + count) % count;
                    subDelay = 0;
                    rememberSubtitleChoice();
                    loadSubtitleFile();
                }
            },
            {
                label: 'Timing',
                value: active ? '< ' + timingLabel() + ' >' : '',
                disabled: !active,
                adjust: function (direction) {
                    subDelay = Math.round((subDelay + direction * SUB_DELAY_STEP) * 100) / 100;
                    rememberSubtitleChoice();
                    drawSubtitles();
                    refreshMenu();
                }
            },
            {
                label: 'Size',
                value: '< ' + SUB_SIZES[subPrefs.size][0] + ' >',
                adjust: function (direction) {
                    subPrefs.size = Math.max(0, Math.min(SUB_SIZES.length - 1, subPrefs.size + direction));
                    saveSubPrefs();
                    styleSubtitles();
                    refreshMenu();
                }
            },
            {
                label: 'Position',
                value: '< ' + (subPrefs.top ? 'Top' : 'Bottom') + ' >',
                adjust: function () {
                    subPrefs.top = !subPrefs.top;
                    saveSubPrefs();
                    styleSubtitles();
                    refreshMenu();
                }
            }
        ];
    }

    function episodeItem(s, e) {
        return {
            label: 'Episode ' + e,
            current: s === season && e === episode,
            action: function () {
                closeMenu();
                goToEpisode({ s: s, e: e });
            }
        };
    }

    function openEpisodes(number) {
        var i = findSeason(number);
        if (i < 0) return;
        pushLevel(seasonTitle(seasons[i]), function () {
            var items = [];
            if (seasons.length > 1) {
                items.push({
                    label: 'Other seasons',
                    value: seasons.length + ' seasons',
                    action: function () { pushLevel('Seasons', buildSeasons); }
                });
            }
            for (var e = 1; e <= seasons[i].episode_count; e++) items.push(episodeItem(number, e));
            return items;
        });
    }

    function seasonItem(item) {
        return {
            label: seasonTitle(item),
            value: item.episode_count + ' episodes',
            current: item.season_number === season,
            action: function () { openEpisodes(item.season_number); }
        };
    }

    function buildSeasons() {
        var items = [];
        for (var i = 0; i < seasons.length; i++) items.push(seasonItem(seasons[i]));
        return items;
    }

    function buildRoot() {
        var items = [];
        var next, prev;
        if (series) {
            next = neighbour(1);
            prev = neighbour(-1);
            items.push({
                label: 'Next episode',
                value: next ? episodeLabel(next) : 'none',
                disabled: !next,
                action: function () {
                    closeMenu();
                    goToEpisode(next);
                }
            });
            items.push({
                label: 'Previous episode',
                value: prev ? episodeLabel(prev) : 'none',
                disabled: !prev,
                action: function () {
                    closeMenu();
                    goToEpisode(prev);
                }
            });
            items.push({
                label: 'Episodes',
                value: episodeLabel({ s: season, e: episode }),
                disabled: findSeason(season) < 0,
                action: function () { openEpisodes(season); }
            });
        }
        if (SUBTITLES) {
            items.push({
                label: 'Subtitles',
                value: subtitleSummary(),
                action: function () { pushLevel('Subtitles', buildSubtitleMenu); }
            });
        }
        items.push({
            label: 'Speed',
            value: speed === null ? '' : speedLabel(speed),
            action: function () { pushLevel('Speed', buildSpeeds); }
        });
        items.push({
            label: 'Player volume',
            value: volume === null ? '< >' : '< ' + Math.round(volume * 100) + '% >',
            adjust: function (direction) { changeVolume(direction * VOLUME_STEP); }
        });
        items.push({ label: 'Start from the beginning', action: restart });
        items.push({
            label: pointerMode ? 'Back to the remote' : 'CineSrc\'s own controls',
            value: pointerMode ? '' : 'needs a mouse',
            action: function () { setPointerMode(!pointerMode); }
        });
        items.push({
            label: 'Diagnostics',
            action: function () { pushLevel('Diagnostics', buildDiagnostics); }
        });
        return items;
    }

    function buildDiagnostics() {
        var types = [];
        var answered = [];
        var silent = [];
        var items = [];
        var key;
        for (key in diag.types) types.push(key.replace('cinesrc:', '') + ' x' + diag.types[key]);
        for (key in diag.asked) {
            if (diag.answered[key]) answered.push(key);
            else silent.push(key);
        }
        items.push({
            label: 'Message details',
            action: function () { pushLevel('Message details', buildDetails); }
        });
        items.push({
            label: 'Messages from the player',
            value: types.length ? types.join(', ') : 'none - the player is not talking to this plugin',
            stacked: true
        });
        items.push({ label: 'Commands it answered', value: answered.join(', ') || 'none', stacked: true });
        items.push({ label: 'Commands it ignored', value: silent.join(', ') || 'none', stacked: true });
        items.push({ label: 'CineSrc server in use', value: sourceId || 'not reported', stacked: true });
        items.push({
            label: 'Subtitle sources',
            value: subNotes.length ? subNotes.join('; ') : (subStatus === 'loading' ? 'searching' : 'not asked yet'),
            stacked: true
        });
        items.push({ label: 'Expected player address', value: ORIGIN, stacked: true });
        if (diag.foreign) {
            items.push({ label: 'Messages ignored from', value: diag.foreign, stacked: true });
        }
        items.push({
            label: 'Now playing',
            value: 'TMDB ' + media.id + (series ? ', ' + episodeLabel({ s: season, e: episode }) : '') +
                ', ' + timeLabel(),
            stacked: true
        });
        return items;
    }

    // What each answer and each kind of message actually contained. The
    // unusual messages come first: they say the most about the player.
    function buildDetails() {
        var routine = ['cinesrc:play', 'cinesrc:pause', 'cinesrc:seeking', 'cinesrc:seeked',
            'cinesrc:loadedmetadata', 'cinesrc:timeupdate'];
        var items = [];
        var key, i;

        function message(type) {
            items.push({
                label: type.replace('cinesrc:', '') + ' message',
                value: diag.last[type],
                stacked: true,
                small: true
            });
        }

        for (key in diag.last) {
            if (routine.indexOf(key) < 0) message(key);
        }
        for (key in diag.results) {
            items.push({ label: key + ' answered', value: diag.results[key], stacked: true, small: true });
        }
        for (i = 0; i < routine.length; i++) {
            if (diag.last[routine[i]]) message(routine[i]);
        }
        if (!items.length) items.push({ label: 'Nothing received yet', stacked: true });
        return items;
    }

    /* ---------- messages from CineSrc ---------- */

    function onResponse(data) {
        var result = data.result;
        var command = data.command;
        var queued;
        if (typeof command !== 'string') return;
        diag.answered[command] = true;
        diag.results[command] = compact(data, ['type', 'command']);
        settle(command);

        if (command === 'getPaused') {
            if (typeof result === 'boolean') paused = result;
            if (pendingToggle) {
                pendingToggle = false;
                if (paused === false) pause();
                else play();
            }
        } else if (command === 'getCurrentTime') {
            if (num(result) && !seekBusy()) {
                time = result;
                timeAt = Date.now();
            }
            queued = pendingSeek;
            pendingSeek = 0;
            if (queued && time !== null) seekBy(queued);
        } else if (command === 'getVolume') {
            queued = pendingVolume;
            pendingVolume = 0;
            if (num(result)) {
                volume = result;
                if (queued) setVolume(volume + queued);
                else refreshMenu();
            }
        } else if (command === 'getPlaybackRate') {
            if (num(result) && result > 0) {
                speed = result;
                refreshMenu();
            }
        } else if (command === 'getDuration') {
            if (num(result) && result > 0 && !duration) duration = result;
        }
    }

    function onMessage(event) {
        if (!overlay || !iframe || event.source !== iframe.contentWindow || !event.data) return;
        if (event.origin !== ORIGIN) {
            diag.foreign = String(event.origin); // shown in Diagnostics
            return;
        }

        var data = event.data;
        var type = typeof data.type === 'string' ? data.type : '';
        if (type.indexOf('cinesrc:') !== 0) return;

        var fresh = !diag.types[type];
        diag.types[type] = (diag.types[type] || 0) + 1;
        if (type !== 'cinesrc:response') diag.last[type] = compact(data, ['type']);
        if (!ready) {
            ready = true; // any message from the player means it is loading
            if (type !== 'cinesrc:ready') syncPlayer(false);
        }

        switch (type) {
            case 'cinesrc:ready':
                syncPlayer(true); // anything asked before this was lost
                break;
            case 'cinesrc:sourceused':
                if (typeof data.sourceId === 'string') sourceId = data.sourceId;
                break;
            case 'cinesrc:play':
                paused = false;
                timeAt = Date.now();
                setTvScreensaver(false);
                if (!osdTimer) settleOsd();
                break;
            case 'cinesrc:pause':
                paused = true;
                setTvScreensaver(true);
                // A pause at the very end that the viewer did not ask for = finished.
                if (duration && num(time) && time >= duration - 2 &&
                    Date.now() - userPauseAt > 1500) {
                    onEnded();
                }
                break;
            case 'cinesrc:ended':
                paused = true;
                setTvScreensaver(true);
                onEnded();
                break;
            case 'cinesrc:loadedmetadata':
                if (num(data.duration) && data.duration > 0) duration = data.duration;
                break;
            case 'cinesrc:volumechange':
                if (num(data.volume)) {
                    volume = data.volume;
                    refreshMenu();
                }
                break;
            case 'cinesrc:seeked':
                if (seekTarget !== null && num(data.currentTime) &&
                    Math.abs(data.currentTime - seekTarget) < 3) {
                    seekHoldUntil = 0;
                }
                /* falls through */
            case 'cinesrc:timeupdate':
                if (num(data.duration) && data.duration > 0) duration = data.duration;
                if (num(data.currentTime) && !seekBusy()) {
                    time = data.currentTime;
                    timeAt = Date.now();
                    seekTarget = null;
                    if (duration && time >= duration - 0.3) onEnded();
                    else if (paused !== true) tickSave();
                }
                break;
            case 'cinesrc:response':
                onResponse(data);
                break;
            case 'cinesrc:close':
                closePlayer();
                break;
            case 'cinesrc:error':
                notify('CineSrc playback error. Try another title or source.');
                break;
        }

        if (!overlay) return;
        maybeResume();
        if (fresh) refreshMenu();
    }

    /* ---------- remote ---------- */

    function stopKey(event) {
        if (event.preventDefault) event.preventDefault();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        if (event.stopPropagation) event.stopPropagation();
    }

    function closeByKey(code) {
        swallowCode = code;
        swallowUntil = Date.now() + 1000;
        closePlayer();
    }

    // Registered once, in the capture phase. Lampa's keypad listens on the
    // same window without capture, so this always runs first and can keep a
    // key from it. That matters for OK in particular: Lampa acts on OK when
    // the key is released and would press whatever card button has focus.
    function onKeyDown(event) {
        var code = event.keyCode || event.which;

        if (!overlay) {
            // Back still held after closing: don't let repeats leave the card.
            if (code === swallowCode && Date.now() < swallowUntil) {
                swallowUntil = Date.now() + 1000;
                stopKey(event);
            }
            return;
        }

        stopKey(event); // Lampa sees nothing while the player is open
        var repeat = !!event.repeat;

        if (menu) {
            armMenuIdle();
            if (menuKey(code, repeat)) return;
        }

        if (countdown) {
            if (isOkKey(code)) {
                if (!repeat) finishCountdown();
                return;
            }
            if (isBackKey(code)) {
                if (!repeat) cancelCountdown();
                return;
            }
            cancelCountdown(); // any other key cancels it and then does its job
        }

        switch (code) {
            case 13:       // OK / Enter
            case 32:       // Space on attached keyboard
            case 10252:    // Samsung MediaPlayPause
                if (!repeat) togglePlayback();
                break;
            case 415:      // MediaPlay
                if (!repeat && requireReady()) play();
                break;
            case 19:       // MediaPause
                if (!repeat && requireReady()) pause();
                break;
            case 37:       // Left
            case 412:      // MediaRewind
                seekBy(-SEEK_STEP);
                break;
            case 39:       // Right
            case 417:      // MediaFastForward
                seekBy(SEEK_STEP);
                break;
            case 38:       // Up
            case 40:       // Down
                if (!repeat) openMenu();
                break;
            case 427:      // Samsung ChannelUp
            case 33:       // PageUp / other TVs' ChannelUp
            case 10233:    // Samsung MediaTrackNext
                if (!repeat) stepEpisode(1);
                break;
            case 428:      // Samsung ChannelDown
            case 34:       // PageDown / other TVs' ChannelDown
            case 10232:    // Samsung MediaTrackPrevious
                if (!repeat) stepEpisode(-1);
                break;
            case 413:      // MediaStop
                if (!repeat) closeByKey(code);
                break;
            case 10009:    // Samsung Back
            case 461:      // Other TVs' Back
            case 27:       // Escape
            case 8:        // Backspace
                if (repeat) break;
                if (pointerMode) setPointerMode(false);
                else closeByKey(code);
                break;
        }
    }

    function onKeyUp(event) {
        if (overlay) {
            stopKey(event);
            return;
        }
        var code = event.keyCode || event.which;
        if (code === swallowCode && Date.now() < swallowUntil) {
            stopKey(event);
            swallowCode = 0;
        }
    }

    // Lampa registers the media and channel keys itself on Samsung TVs; the
    // two track keys are the only ones it leaves out.
    function registerRemoteKeys() {
        try {
            if (window.tizen && tizen.tvinputdevice && tizen.tvinputdevice.registerKey) {
                var names = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
                    'MediaRewind', 'MediaFastForward', 'MediaTrackNext', 'MediaTrackPrevious',
                    'ChannelUp', 'ChannelDown'];
                for (var i = 0; i < names.length; i++) {
                    try { tizen.tvinputdevice.registerKey(names[i]); }
                    catch (ignored) {}
                }
            }
        } catch (ignored) {
            // Tizen APIs aren't available in browser-based Lampa installs.
        }
    }

    /* ---------- focus, pointer mode, screensavers, backgrounding ---------- */

    function focusOverlay() {
        if (!overlay) return;
        try { overlay.focus({ preventScroll: true }); }
        catch (e) { try { overlay.focus(); } catch (ignored) {} }
    }

    // If focus lands in the iframe, keys go to CineSrc instead of this plugin.
    // Take it back: at once normally, after a short grace in pointer mode so
    // CineSrc's own menus can be clicked through.
    function reclaimFocus() {
        if (focusTimer) clearTimeout(focusTimer);
        focusTimer = setTimeout(function () {
            focusTimer = null;
            if (overlay && document.activeElement === iframe) focusOverlay();
        }, pointerMode ? POINTER_FOCUS_MS : 0);
    }

    // Pointer mode lets a mouse use CineSrc's own controls, which is the only
    // way to reach what its API does not offer: quality, audio track, server
    // and its own subtitles. The remote keeps working whenever focus is back
    // with the plugin.
    function setPointerMode(on) {
        if (!overlay || on === pointerMode) return;
        pointerMode = on;
        closeMenu();
        iframe.style.pointerEvents = on ? 'auto' : 'none';
        if (on) {
            if (!nativeControls) {
                saveProgress();
                load(); // reload once with CineSrc's controls visible
            }
            osd('Mouse mode', '', 0, 'Click in the video to use CineSrc\'s controls. Back returns to the remote.');
        } else {
            focusOverlay();
            osd('Remote control', '', 0);
        }
    }

    // The TV's own screensaver doesn't know an iframe video is playing.
    function setTvScreensaver(enabled) {
        try {
            var common = window.webapis && window.webapis.appcommon;
            if (common && common.setScreenSaver && common.AppCommonScreenSaverState) {
                common.setScreenSaver(enabled ?
                    common.AppCommonScreenSaverState.SCREEN_SAVER_ON :
                    common.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
            }
        } catch (ignored) {}
    }

    // Lampa's screensaver restarts its countdown on key presses, and this
    // player keeps all keys to itself, so Lampa would start its slideshow
    // behind the video. Switch it off while the player is open.
    function pauseLampaScreensaver() {
        try {
            lampaScreensaverWas = !!(Lampa.Screensaver && Lampa.Screensaver.enabled);
            if (lampaScreensaverWas) Lampa.Screensaver.disable();
        } catch (ignored) {
            lampaScreensaverWas = false;
        }
    }

    function resumeLampaScreensaver() {
        try {
            if (lampaScreensaverWas) Lampa.Screensaver.enable();
        } catch (ignored) {}
        lampaScreensaverWas = false;
    }

    function onVisibilityChange() {
        if (document.hidden && overlay && ready && paused !== true) pause();
    }

    /* ---------- open / load / close ---------- */

    // (Re)loads the iframe for the current title or episode.
    function load() {
        var saved;
        resetLoad();
        resetSubtitles();
        nativeControls = pointerMode;
        if (RESUME) {
            saved = readMap(PROGRESS_KEY)[progressId()];
            if (saved && saved.t > RESUME_MIN && (!saved.d || saved.t < saved.d - RESUME_END_GAP)) {
                resumeAt = saved.t;
            }
        }
        iframe.src = makeUrl();
        osd(series ? episodeLabel({ s: season, e: episode }) : 'Loading', series ? 'Loading' : '', 0);
        // A language chosen earlier comes back by itself.
        if (SUBTITLES && subPrefs.lang) loadSubtitleList();
        refreshMenu();
    }

    function closePlayer() {
        if (!overlay) return;
        saveProgress();

        var oldOverlay = overlay;
        var oldFrame = iframe;
        clearLoadTimers();
        resetSubtitles();
        if (menuTimer) clearTimeout(menuTimer);
        if (focusTimer) clearTimeout(focusTimer);
        menuTimer = null;
        focusTimer = null;
        countdown = null;
        menu = null;
        overlay = null;
        iframe = null;
        osdBox = osdLabel = osdValue = osdBar = osdHint = null;
        menuBox = menuTitle = menuList = null;
        subBox = null;
        media = null;
        pointerMode = false;
        nativeControls = false;

        window.removeEventListener('message', onMessage, false);
        window.removeEventListener('blur', reclaimFocus, false);
        document.removeEventListener('focus', reclaimFocus, true);
        document.removeEventListener('visibilitychange', onVisibilityChange, false);
        setTvScreensaver(true);
        resumeLampaScreensaver();

        if (oldFrame) {
            try { oldFrame.src = 'about:blank'; } catch (ignored) {}
        }
        if (oldOverlay.parentNode) oldOverlay.parentNode.removeChild(oldOverlay);
        document.body.style.overflow = previousOverflow;

        try { Lampa.Controller.toggle(returnController); }
        catch (error) {
            try { Lampa.Controller.toggle('content'); } catch (ignored) {}
        }
    }

    function openPlayer(movie, s, e, returnTo) {
        if (!movie || !validTmdbId(movie.id)) {
            notify('EltonTV: invalid TMDB ID for this title.');
            return;
        }
        if (overlay) closePlayer();

        media = movie;
        series = isSeries(movie);
        season = series ? positiveInt(s) : 0;
        episode = series ? positiveInt(e) : 0;
        seasons = series ? seasonList(movie) : [];
        pointerMode = false;
        nativeControls = false;
        menu = null;
        subPrefs = readSubPrefs();
        returnController = returnTo || activeControllerName();
        previousOverflow = document.body.style.overflow;
        if (series) saveLastEpisode(movie.id, season, episode);

        overlay = document.createElement('div');
        overlay.className = 'eltontv-fullscreen';
        overlay.tabIndex = 0;
        overlay.setAttribute('aria-label', 'CineSrc fullscreen video');
        overlay.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;' +
            'width:100%;height:100%;z-index:2147483647;background:#000;' +
            'margin:0;padding:0;border:0;overflow:hidden;outline:none;';

        iframe = document.createElement('iframe');
        iframe.title = 'CineSrc player';
        iframe.tabIndex = -1;
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('scrolling', 'no');
        iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
        iframe.setAttribute('allowfullscreen', '');
        iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;' +
            'margin:0;padding:0;background:#000;pointer-events:none;';
        iframe.addEventListener('load', reclaimFocus, false);
        overlay.appendChild(iframe);
        if (SUBTITLES) buildSubtitleBox();
        if (SHOW_OSD) buildOsd();
        buildMenu();
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';

        window.addEventListener('message', onMessage, false);
        window.addEventListener('blur', reclaimFocus, false);
        document.addEventListener('focus', reclaimFocus, true);
        document.addEventListener('visibilitychange', onVisibilityChange, false);
        registerRemoteKeys();
        pauseLampaScreensaver();

        // Lampa's controller only has to know the player owns the screen.
        // Keys are handled by onKeyDown; a back from elsewhere just closes.
        Lampa.Controller.add(CONTROLLER, {
            invisible: true,
            toggle: focusOverlay,
            back: closePlayer
        });
        Lampa.Controller.toggle(CONTROLLER);
        load();
        focusOverlay();
    }

    /* ---------- before playing a series: season / episode picker ---------- */

    function pickEpisode(movie, returnTo, done) {
        var list = seasonList(movie);
        var last = loadLastEpisode(movie.id);

        // No season data or no picker: last episode watched, else S1E1.
        if (!list.length || !Lampa.Select || !Lampa.Select.show) {
            done(last ? last.s : 1, last ? last.e : 1);
            return;
        }

        function backToCard() {
            Lampa.Controller.toggle(returnTo);
        }

        // Let Lampa.Select finish closing before the next screen opens.
        function later(fn) {
            setTimeout(fn, 0);
        }

        function continueItem() {
            return { title: 'Continue S' + last.s + ' E' + last.e, resume: true, selected: true };
        }

        function showEpisodes(item, onBack, withContinue) {
            var items = [];
            if (withContinue && last) items.push(continueItem());
            for (var e = 1; e <= item.episode_count; e++) {
                items.push({
                    title: 'Episode ' + e,
                    episode: e,
                    selected: !(withContinue && last) && !!last &&
                        item.season_number === last.s && e === last.e
                });
            }
            Lampa.Select.show({
                title: seasonTitle(item),
                items: items,
                onSelect: function (chosen) {
                    later(function () {
                        if (chosen.resume) done(last.s, last.e);
                        else done(item.season_number, chosen.episode);
                    });
                },
                onBack: onBack
            });
        }

        function showSeasons() {
            var items = [];
            if (last) items.push(continueItem());
            for (var i = 0; i < list.length; i++) {
                items.push({
                    title: seasonTitle(list[i]),
                    subtitle: list[i].episode_count + ' episodes',
                    season: list[i]
                });
            }
            Lampa.Select.show({
                title: movie.name || movie.title || 'Seasons',
                items: items,
                onSelect: function (chosen) {
                    later(function () {
                        if (chosen.resume) done(last.s, last.e);
                        else showEpisodes(chosen.season, showSeasons, false);
                    });
                },
                onBack: backToCard
            });
        }

        if (list.length === 1) showEpisodes(list[0], backToCard, true);
        else showSeasons();
    }

    function start(movie) {
        var returnTo = activeControllerName();
        if (!isSeries(movie)) {
            openPlayer(movie, 0, 0, returnTo);
            return;
        }
        pickEpisode(movie, returnTo, function (s, e) {
            openPlayer(movie, s, e, returnTo);
        });
    }

    /* ---------- Lampa integration ---------- */

    function addButton(event) {
        if (!event || event.type !== 'complite' || !event.object ||
            !event.object.activity || !event.object.activity.render) return;

        var movie = event.data && event.data.movie;
        if (!movie || !validTmdbId(movie.id)) return;

        var screen = event.object.activity.render();
        var buttons = screen.find('.full-start-new__buttons, .full-start__buttons').first();
        if (!buttons.length || buttons.find('.view--eltontv').length) return;

        var button = window.jQuery(
            '<div class="full-start__button full-start-new__button selector view--eltontv"><span>CineSrc</span></div>'
        );
        // Lampa already turns mouse clicks into hover:enter.
        button.on('hover:enter', function () { start(movie); });
        buttons.append(button);
    }

    function init() {
        if (initialized || !window.Lampa || !window.jQuery) return;
        initialized = true;
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        if (Lampa.Manifest) {
            Lampa.Manifest.plugins = {
                type: 'video',
                version: '2.4.0',
                name: 'EltonTV CineSrc - Fullscreen Remote',
                description: 'Fullscreen CineSrc with Samsung TV remote controls'
            };
        }
        Lampa.Listener.follow('full', addButton);
    }

    if (window.Lampa && Lampa.Listener) {
        if (window.appready) init();
        else Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') init();
        });
    }
})();

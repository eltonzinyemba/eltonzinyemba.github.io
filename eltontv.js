/*
 * EltonTV / CineSrc for Lampa - 2.3.0 (Samsung TV remote edition)
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
 * Player menu: next / previous episode, episode list, subtitles, quality,
 * audio, speed, player volume, restart, CineSrc's own controls (pointer or
 * mouse), diagnostics.
 *
 * Also: season/episode picker with "Continue", resume where you stopped,
 * next episode starts by itself after a countdown you can cancel.
 *
 * IMPORTANT: subtitles, quality, audio and speed need commands in CineSrc's
 * API whose names are not confirmed. See FEATURES below. Whatever the player
 * does not answer shows as "not available"; Diagnostics in the menu lists
 * what it did answer.
 */
(function () {
    'use strict';

    if (window.eltontv_cinesrc_remote_230) return;
    window.eltontv_cinesrc_remote_230 = true;

    var ORIGIN = 'https://cinesrc.st';
    var CONTROLLER = 'eltontv_cinesrc_remote';
    var EPISODE_KEY = 'eltontv_cinesrc_last_episode';
    var PROGRESS_KEY = 'eltontv_cinesrc_progress';

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

    // Optional player features. Their command names are NOT confirmed: they
    // are the usual names for this style of API. Every variant is tried when
    // the player loads; the first one that answers is used, and a feature
    // nobody answers shows as "not available" in the menu.
    // To correct a feature, edit its variants here. Nothing else changes.
    //   list     command that returns an array of options
    //   current  command that returns the active option (optional)
    //   set      command that takes the chosen option
    //   off      command that switches the feature off (optional; otherwise
    //            set is sent with null)
    var FEATURES = {
        subtitles: {
            title: 'Subtitles',
            canTurnOff: true,
            variants: [
                { list: 'getTextTracks', set: 'enableTextTrack', off: 'disableTextTrack' },
                { list: 'getSubtitles', current: 'getSubtitle', set: 'setSubtitle' },
                { list: 'getCaptions', current: 'getCaption', set: 'setCaption' }
            ]
        },
        quality: {
            title: 'Quality',
            variants: [
                { list: 'getQualities', current: 'getQuality', set: 'setQuality' },
                { list: 'getQualityLevels', current: 'getQualityLevel', set: 'setQualityLevel' }
            ]
        },
        audio: {
            title: 'Audio',
            variants: [
                { list: 'getAudioTracks', current: 'getAudioTrack', set: 'setAudioTrack' }
            ]
        },
        speed: {
            title: 'Speed',
            values: SPEEDS,
            variants: [
                { current: 'getPlaybackRate', set: 'setPlaybackRate' },
                { current: 'getSpeed', set: 'setSpeed' }
            ]
        }
    };
    var FEATURE_ORDER = ['subtitles', 'quality', 'audio', 'speed'];

    var FLEX_ROW = 'display:-webkit-box;display:-webkit-flex;display:flex;' +
        '-webkit-box-pack:justify;-webkit-justify-content:space-between;justify-content:space-between;';
    var ROW_CSS = FLEX_ROW + '-webkit-box-align:center;-webkit-align-items:center;align-items:center;' +
        'padding:1.5vh 1.6vh;margin-bottom:0.4vh;border-radius:0.8vh;';
    var ROW_STACKED_CSS = 'display:block;padding:1.5vh 1.6vh;margin-bottom:0.4vh;border-radius:0.8vh;';
    var VALUE_CSS = 'opacity:0.7;margin-left:2vh;text-align:right;';
    var VALUE_STACKED_CSS = 'display:block;margin-top:0.4vh;word-wrap:break-word;';
    var LABEL_STACKED_CSS = 'display:block;opacity:0.7;font-size:2.1vh;';
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
    var initialized = false;
    var swallowCode = 0;           // key that closed the player...
    var swallowUntil = 0;          // ...its repeats/key-up are hidden from Lampa

    // What is open (set by openPlayer).
    var media = null;
    var series = false;
    var season = 0;
    var episode = 0;
    var seasons = [];
    var returnController = 'content';
    var previousOverflow = '';
    var pointerMode = false;       // iframe accepts the pointer
    var nativeControls = false;    // current page was loaded with CineSrc's own controls
    var menu = null;               // null, or a stack of menu levels
    var menuTimer = null;
    var focusTimer = null;

    // Per page load of the iframe (reset by resetLoad).
    var ready, paused, time, duration, volume;
    var seekTarget, seekDelta, seekTimer, seekHoldUntil, pendingSeek;
    var pendingToggle, pendingVolume, inflight, osdTimer;
    var resumeAt, finished, lastSaveAt, userPauseAt, countdown;
    var feat, probeTimer, lastProbeAt, diag;

    function clearLoadTimers() {
        var key;
        if (seekTimer) clearTimeout(seekTimer);
        if (osdTimer) clearTimeout(osdTimer);
        if (probeTimer) clearTimeout(probeTimer);
        if (countdown && countdown.timer) clearInterval(countdown.timer);
        if (inflight) {
            for (key in inflight) {
                if (inflight[key]) clearTimeout(inflight[key]);
            }
        }
    }

    function resetLoad() {
        var i;
        clearLoadTimers();
        ready = false;
        paused = null;          // null = unknown
        time = null;
        duration = null;
        volume = null;          // 0..1, null = unknown
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
        probeTimer = null;
        lastProbeAt = 0;
        feat = {};
        for (i = 0; i < FEATURE_ORDER.length; i++) {
            feat[FEATURE_ORDER[i]] = { status: 'checking', variant: null, options: [], current: null };
        }
        diag = { types: {}, asked: {}, answered: {}, foreign: '' };
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

    function firstDefined() {
        for (var i = 0; i < arguments.length; i++) {
            if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i];
        }
        return undefined;
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
        try { Lampa.Storage.set(key, map); } catch (ignored) {}
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
    function request(command) {
        if (inflight[command]) return;
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

    /* ---------- optional features: subtitles, quality, audio, speed ---------- */

    function optionLabel(name, value) {
        if (name === 'quality' && num(value)) return value + 'p';
        if (name === 'speed') return value === 1 ? 'Normal' : value + 'x';
        return String(value);
    }

    // Accepts plain values or objects in the shapes players usually return.
    function normalizeOptions(name, list) {
        var options = [];
        var active = null;
        var i, entry, value, label;
        for (i = 0; i < list.length; i++) {
            entry = list[i];
            if (entry === null || entry === undefined) continue;
            if (typeof entry === 'object') {
                value = firstDefined(entry.id, entry.value, entry.index, entry.language,
                    entry.lang, entry.label, entry.name);
                if (value === undefined) value = i;
                label = firstDefined(entry.label, entry.name, entry.title, entry.language,
                    entry.lang, num(entry.height) ? entry.height + 'p' : undefined);
                if (label === undefined) label = optionLabel(name, value);
                if (entry.mode === 'showing' || entry.active === true ||
                    entry.selected === true || entry.current === true) {
                    active = String(value);
                }
            } else {
                value = entry;
                label = optionLabel(name, value);
            }
            options.push({ id: String(value), value: value, label: String(label) });
        }
        return { options: options, active: active };
    }

    function toOptionId(name, f, result) {
        var id, i;
        if (result === null || result === undefined || result === false || result === '') return null;
        if (typeof result === 'object') {
            id = firstDefined(result.id, result.value, result.index, result.language,
                result.lang, result.label, result.name);
            if (id === undefined) return null;
        } else {
            id = result;
        }
        id = String(id);
        for (i = 0; i < f.options.length; i++) {
            if (f.options[i].id === id) return id;
        }
        // Not an id we know: it may be a position in the list.
        if (num(result) && result % 1 === 0 && result >= 0 && result < f.options.length) {
            return f.options[result].id;
        }
        return FEATURES[name].canTurnOff ? null : id;
    }

    function findProbe(command) {
        var i, j, name, variants;
        for (i = 0; i < FEATURE_ORDER.length; i++) {
            name = FEATURE_ORDER[i];
            variants = FEATURES[name].variants;
            for (j = 0; j < variants.length; j++) {
                if (variants[j].list === command) return { name: name, variant: variants[j], kind: 'list' };
                if (variants[j].current === command) return { name: name, variant: variants[j], kind: 'current' };
            }
        }
        return null;
    }

    function probeFeatures(force) {
        var i, j, f, variants;
        if (!ready) return;
        if (!force && Date.now() - lastProbeAt < 3000) return;
        lastProbeAt = Date.now();

        for (i = 0; i < FEATURE_ORDER.length; i++) {
            f = feat[FEATURE_ORDER[i]];
            if (f.status === 'ready') {
                // Known feature: refresh it (subtitle lists often arrive late).
                if (f.variant.list) request(f.variant.list);
                if (f.variant.current) request(f.variant.current);
            } else {
                variants = FEATURES[FEATURE_ORDER[i]].variants;
                for (j = 0; j < variants.length; j++) {
                    request(variants[j].list || variants[j].current);
                }
            }
        }

        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = setTimeout(function () {
            probeTimer = null;
            for (var k = 0; k < FEATURE_ORDER.length; k++) {
                if (feat[FEATURE_ORDER[k]].status === 'checking') feat[FEATURE_ORDER[k]].status = 'none';
            }
            refreshMenu();
        }, REQUEST_TIMEOUT_MS + 300);
    }

    function onFeatureResponse(hit, data) {
        var spec = FEATURES[hit.name];
        var f = feat[hit.name];
        var result = data.result;
        var parsed;
        if (data.error) return;
        if (f.status === 'ready' && f.variant !== hit.variant) return;

        if (hit.kind === 'list') {
            if (!isArray(result)) return;
            parsed = normalizeOptions(hit.name, result);
            f.options = parsed.options;
            if (f.status !== 'ready') {
                f.status = 'ready';
                f.variant = hit.variant;
                if (hit.variant.current) request(hit.variant.current);
            }
            if (!hit.variant.current) f.current = parsed.active;
            else if (f.current === null && parsed.active !== null) f.current = parsed.active;
        } else if (spec.values) {
            if (!num(result)) return;
            if (f.status !== 'ready') {
                f.status = 'ready';
                f.variant = hit.variant;
                f.options = normalizeOptions(hit.name, spec.values).options;
            }
            f.current = toOptionId(hit.name, f, result);
        } else {
            if (f.status !== 'ready') return;
            f.current = toOptionId(hit.name, f, result);
        }
        refreshMenu();
    }

    function currentLabel(name) {
        var f = feat[name];
        for (var i = 0; i < f.options.length; i++) {
            if (f.options[i].id === f.current) return f.options[i].label;
        }
        if (f.current !== null) return optionLabel(name, f.current);
        return FEATURES[name].canTurnOff ? 'Off' : '';
    }

    function chooseOption(name, option) {
        var spec = FEATURES[name];
        var f = feat[name];
        if (f.status !== 'ready') return;
        if (option) send(f.variant.set, [option.value]);
        else if (f.variant.off) send(f.variant.off);
        else send(f.variant.set, [null]);
        f.current = option ? option.id : null;
        osd(spec.title, option ? option.label : 'Off', 0);
        popLevel();
        if (f.variant.current) {
            // Ask the player what it actually switched to.
            setTimeout(function () {
                if (overlay && feat[name] === f) request(f.variant.current);
            }, 800);
        }
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
        if (item.stacked) label.style.cssText = LABEL_STACKED_CSS;
        if (typeof item.current === 'boolean') {
            dot = document.createElement('span');
            dot.style.cssText = DOT_CSS + (item.current ? '' : 'visibility:hidden;');
            label.appendChild(dot);
        }
        label.appendChild(document.createTextNode(item.label));
        row.appendChild(label);
        if (item.value) {
            value = document.createElement('span');
            value.style.cssText = item.stacked ? VALUE_STACKED_CSS : VALUE_CSS;
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

    function featureRow(name) {
        var spec = FEATURES[name];
        var f = feat[name];
        if (f.status !== 'ready') {
            return {
                label: spec.title,
                value: f.status === 'checking' ? 'checking' : 'not available',
                disabled: true
            };
        }
        if (!f.options.length) return { label: spec.title, value: 'none found', disabled: true };
        return {
            label: spec.title,
            value: currentLabel(name),
            action: function () {
                pushLevel(spec.title, function () { return buildOptions(name); });
            }
        };
    }

    function optionItem(name, option) {
        return {
            label: option ? option.label : 'Off',
            current: feat[name].current === (option ? option.id : null),
            action: function () { chooseOption(name, option); }
        };
    }

    function buildOptions(name) {
        var f = feat[name];
        var items = [];
        var hasOff = false;
        var i;
        for (i = 0; i < f.options.length; i++) {
            if (/^(off|none|disabled)$/i.test(f.options[i].label)) hasOff = true;
        }
        if (FEATURES[name].canTurnOff && !hasOff) items.push(optionItem(name, null));
        for (i = 0; i < f.options.length; i++) items.push(optionItem(name, f.options[i]));
        return items;
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
        var next, prev, i;
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
        for (i = 0; i < FEATURE_ORDER.length; i++) items.push(featureRow(FEATURE_ORDER[i]));
        items.push({
            label: 'Player volume',
            value: volume === null ? '< >' : '< ' + Math.round(volume * 100) + '% >',
            adjust: function (direction) { changeVolume(direction * VOLUME_STEP); }
        });
        items.push({ label: 'Start from the beginning', action: restart });
        items.push({
            label: pointerMode ? 'Back to the remote' : 'CineSrc\'s own controls',
            value: pointerMode ? '' : 'pointer or mouse',
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
            label: 'Messages from the player',
            value: types.length ? types.join(', ') : 'none - the player is not talking to this plugin',
            stacked: true
        });
        items.push({ label: 'Commands it answered', value: answered.join(', ') || 'none', stacked: true });
        items.push({ label: 'Commands it ignored', value: silent.join(', ') || 'none', stacked: true });
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

    /* ---------- messages from CineSrc ---------- */

    function syncPlayer(force) {
        if (!ready) return;
        if (paused === null) request('getPaused');
        if (volume === null) request('getVolume');
        probeFeatures(force);
    }

    function onResponse(data) {
        var result = data.result;
        var command = data.command;
        var queued, hit;
        if (typeof command !== 'string') return;
        diag.answered[command] = true;

        if (command === 'getPaused') {
            settle('getPaused');
            if (typeof result === 'boolean') paused = result;
            if (pendingToggle) {
                pendingToggle = false;
                if (paused === false) pause();
                else play();
            }
        } else if (command === 'getCurrentTime') {
            settle('getCurrentTime');
            if (num(result) && !seekBusy()) time = result;
            queued = pendingSeek;
            pendingSeek = 0;
            if (queued && time !== null) seekBy(queued);
        } else if (command === 'getVolume') {
            settle('getVolume');
            queued = pendingVolume;
            pendingVolume = 0;
            if (num(result)) {
                volume = result;
                if (queued) setVolume(volume + queued);
                else refreshMenu();
            }
        } else {
            settle(command);
            hit = findProbe(command);
            if (hit) onFeatureResponse(hit, data);
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
        if (!ready) {
            ready = true; // any message from the player means it is listening
            syncPlayer(true);
        }

        switch (type) {
            case 'cinesrc:ready':
                syncPlayer(true);
                break;
            case 'cinesrc:play':
                paused = false;
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
                if (num(data.duration)) duration = data.duration;
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
                if (num(data.duration)) duration = data.duration;
                if (num(data.currentTime) && !seekBusy()) {
                    time = data.currentTime;
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

    // Registered once, in the capture phase, so it runs before Lampa's keypad.
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

    /* ---------- focus, pointer mode, screensaver, backgrounding ---------- */

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

    // Pointer mode lets a pointer or mouse use CineSrc's own controls, which
    // is the only way to reach anything its API does not offer (servers, for
    // one). The remote keeps working whenever focus is back with the plugin.
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
            osd('Pointer mode', '', 0, 'Point at the video to use CineSrc\'s controls. Back returns to the remote.');
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

    function onVisibilityChange() {
        if (document.hidden && overlay && ready && paused !== true) pause();
    }

    /* ---------- open / load / close ---------- */

    // (Re)loads the iframe for the current title or episode.
    function load() {
        var saved;
        resetLoad();
        nativeControls = pointerMode;
        if (RESUME) {
            saved = readMap(PROGRESS_KEY)[progressId()];
            if (saved && saved.t > RESUME_MIN && (!saved.d || saved.t < saved.d - RESUME_END_GAP)) {
                resumeAt = saved.t;
            }
        }
        iframe.src = makeUrl();
        osd(series ? episodeLabel({ s: season, e: episode }) : 'Loading', series ? 'Loading' : '', 0);
        refreshMenu();
    }

    function closePlayer() {
        if (!overlay) return;
        saveProgress();

        var oldOverlay = overlay;
        var oldFrame = iframe;
        clearLoadTimers();
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
        media = null;
        pointerMode = false;
        nativeControls = false;

        window.removeEventListener('message', onMessage, false);
        window.removeEventListener('blur', reclaimFocus, false);
        document.removeEventListener('focus', reclaimFocus, true);
        document.removeEventListener('visibilitychange', onVisibilityChange, false);
        setTvScreensaver(true);

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
        if (SHOW_OSD) buildOsd();
        buildMenu();
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';

        window.addEventListener('message', onMessage, false);
        window.addEventListener('blur', reclaimFocus, false);
        document.addEventListener('focus', reclaimFocus, true);
        document.addEventListener('visibilitychange', onVisibilityChange, false);
        registerRemoteKeys();

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
                version: '2.3.0',
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

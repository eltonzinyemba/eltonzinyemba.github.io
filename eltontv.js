/*
 * EltonTV / CineSrc for Lampa - 2.2.0 (Samsung TV remote edition)
 *
 * Full-viewport CineSrc iframe driven through CineSrc's postMessage API.
 * While the player is open every remote key is handled here and none reach
 * Lampa, so no action can fire twice.
 *
 * Remote:
 *   OK / Play-Pause       toggle playback
 *   Play, Pause           play, pause
 *   Left/Right, Rew/FF    -/+10 s (quick presses add up into one seek)
 *   Up/Down               embedded-player volume +/-10 %
 *   Back / Stop           return to Lampa
 * The TV's own volume keys stay with the TV.
 *
 * Series open a season/episode picker first and remember the last episode.
 * A small on-screen display shows position, seek amount, volume and pause
 * state for a moment after each key press (SHOW_OSD = false removes it).
 *
 * CineSrc is a cross-origin iframe: its own server/subtitle menus are not
 * reachable from the remote.
 */
(function () {
    'use strict';

    if (window.eltontv_cinesrc_remote_220) return;
    window.eltontv_cinesrc_remote_220 = true;

    var ORIGIN = 'https://cinesrc.st';
    var CONTROLLER = 'eltontv_cinesrc_remote';
    var STORE_KEY = 'eltontv_cinesrc_last_episode';

    var SHOW_OSD = true;
    var OSD_MS = 2500;             // OSD stays this long after a key press
    var SEEK_STEP = 10;            // seconds per Left/Right press
    var VOLUME_STEP = 0.1;
    var SEEK_DEBOUNCE_MS = 400;    // presses closer than this become one seek
    var SEEK_HOLD_MS = 2000;       // ignore stale timeupdates after a seek
    var REQUEST_TIMEOUT_MS = 2500; // give up on an unanswered get* request

    var overlay = null;
    var iframe = null;
    var osdBox = null;
    var osdLabel = null;
    var osdValue = null;
    var osdBar = null;
    var returnController = 'content';
    var previousOverflow = '';
    var initialized = false;
    var swallowCode = 0;           // key that closed the player...
    var swallowUntil = 0;          // ...its repeats/key-up are hidden from Lampa

    // Per-session player state, reset by resetState().
    var ready, paused, time, duration, volume;
    var seekTarget, seekDelta, seekTimer, seekHoldUntil, pendingSeek;
    var pendingToggle, pendingVolume, inflight, osdTimer;

    function clearTimers() {
        if (seekTimer) clearTimeout(seekTimer);
        if (osdTimer) clearTimeout(osdTimer);
        if (inflight) {
            for (var key in inflight) {
                if (inflight[key]) clearTimeout(inflight[key]);
            }
        }
    }

    function resetState() {
        clearTimers();
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
    }
    resetState();

    /* ---------- helpers ---------- */

    function notify(message) {
        if (window.Lampa && Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
    }

    function num(value) {
        return typeof value === 'number' && isFinite(value);
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

    function makeUrl(movie, season, episode) {
        if (!movie || !validTmdbId(movie.id)) return null;
        var id = encodeURIComponent(String(movie.id));
        var url = ORIGIN + '/embed/';
        if (isSeries(movie)) {
            url += 'tv/' + id + '?s=' + positiveInt(season) + '&e=' + positiveInt(episode) + '&';
        } else {
            url += 'movie/' + id + '?';
        }
        return url + 'autoplay=true&controls=false&back=close';
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

    /* ---------- on-screen display ---------- */

    function buildOsd() {
        osdBox = document.createElement('div');
        osdBox.style.cssText = 'position:absolute;left:4vh;bottom:4vh;width:46vh;max-width:80%;' +
            'box-sizing:border-box;padding:1.6vh 2.2vh 1.8vh;border-radius:0.8vh;' +
            'background:rgba(0,0,0,0.7);color:#fff;font:500 2.8vh/1.3 sans-serif;' +
            'pointer-events:none;opacity:0;-webkit-transition:opacity .2s;transition:opacity .2s;';

        var row = document.createElement('div');
        row.style.cssText = 'display:-webkit-box;display:-webkit-flex;display:flex;' +
            '-webkit-box-pack:justify;-webkit-justify-content:space-between;justify-content:space-between;';
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

        osdBox.appendChild(row);
        osdBox.appendChild(track);
        overlay.appendChild(osdBox);
    }

    function paintOsd(label, value, fraction) {
        osdLabel.textContent = label;
        osdValue.textContent = value || '';
        osdBar.style.width = Math.max(0, Math.min(100, (fraction || 0) * 100)) + '%';
    }

    function osd(label, value, fraction) {
        if (!osdBox) return;
        paintOsd(label, value, fraction);
        osdBox.style.opacity = '1';
        if (osdTimer) clearTimeout(osdTimer);
        osdTimer = setTimeout(settleOsd, OSD_MS);
    }

    // After a key press: hide, unless paused, where a pause card stays up.
    function settleOsd() {
        osdTimer = null;
        if (!osdBox) return;
        if (paused === true) paintOsd('Paused', timeLabel(), progress());
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
        showPosition('Paused');
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
        seekHoldUntil = Date.now() + SEEK_HOLD_MS;
        send('seek', [seekTarget]);
    }

    function setVolume(level) {
        volume = Math.round(Math.max(0, Math.min(1, level)) * 100) / 100;
        send('setVolume', [volume]);
        osd('Volume', Math.round(volume * 100) + '%', volume);
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

    /* ---------- messages from CineSrc ---------- */

    function onResponse(data) {
        var result = data.result;
        var queued;
        if (data.command === 'getPaused') {
            settle('getPaused');
            if (typeof result === 'boolean') paused = result;
            if (pendingToggle) {
                pendingToggle = false;
                if (paused === false) pause();
                else play();
            }
        } else if (data.command === 'getCurrentTime') {
            settle('getCurrentTime');
            if (num(result) && !seekBusy()) time = result;
            queued = pendingSeek;
            pendingSeek = 0;
            if (queued && time !== null) seekBy(queued);
        } else if (data.command === 'getVolume') {
            settle('getVolume');
            queued = pendingVolume;
            pendingVolume = 0;
            if (num(result)) {
                volume = result;
                if (queued) setVolume(volume + queued);
            }
        }
    }

    function onMessage(event) {
        if (!overlay || !iframe || event.origin !== ORIGIN ||
            event.source !== iframe.contentWindow || !event.data) return;

        var data = event.data;
        ready = true; // any message from the player means it is listening

        switch (data.type) {
            case 'cinesrc:ready':
                request('getPaused');
                request('getVolume');
                break;
            case 'cinesrc:play':
                paused = false;
                setTvScreensaver(false);
                if (!osdTimer) settleOsd();
                break;
            case 'cinesrc:pause':
                paused = true;
                setTvScreensaver(true);
                break;
            case 'cinesrc:loadedmetadata':
                if (num(data.duration)) duration = data.duration;
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
    }

    /* ---------- remote ---------- */

    function stopKey(event) {
        if (event.preventDefault) event.preventDefault();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        if (event.stopPropagation) event.stopPropagation();
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
                changeVolume(VOLUME_STEP);
                break;
            case 40:       // Down
                changeVolume(-VOLUME_STEP);
                break;
            case 10009:    // Samsung Back
            case 461:      // Other TVs' Back
            case 27:       // Escape
            case 8:        // Backspace
            case 413:      // MediaStop
                if (!repeat) {
                    swallowCode = code;
                    swallowUntil = Date.now() + 1000;
                    closePlayer();
                }
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

    function registerMediaKeys() {
        try {
            if (window.tizen && tizen.tvinputdevice && tizen.tvinputdevice.registerKey) {
                var names = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
                    'MediaRewind', 'MediaFastForward'];
                for (var i = 0; i < names.length; i++) {
                    try { tizen.tvinputdevice.registerKey(names[i]); }
                    catch (ignored) {}
                }
            }
        } catch (ignored) {
            // Tizen APIs aren't available in browser-based Lampa installs.
        }
    }

    /* ---------- focus, screensaver, backgrounding ---------- */

    function focusOverlay() {
        if (!overlay) return;
        try { overlay.focus({ preventScroll: true }); }
        catch (e) { try { overlay.focus(); } catch (ignored) {} }
    }

    // If the TV web engine hands focus to the iframe, keys would go to
    // CineSrc instead of this plugin. Take it back.
    function reclaimFocus() {
        setTimeout(function () {
            if (overlay && document.activeElement === iframe) focusOverlay();
        }, 0);
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

    /* ---------- open / close ---------- */

    function closePlayer() {
        if (!overlay) return;
        var oldOverlay = overlay;
        var oldFrame = iframe;
        clearTimers();
        overlay = null;
        iframe = null;
        osdBox = osdLabel = osdValue = osdBar = null;

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

    function openPlayer(movie, season, episode, returnTo) {
        var url = makeUrl(movie, season, episode);
        if (!url) {
            notify('EltonTV: invalid TMDB ID for this title.');
            return;
        }
        if (overlay) closePlayer();

        resetState();
        returnController = returnTo || activeControllerName();
        previousOverflow = document.body.style.overflow;

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
        iframe.addEventListener('load', focusOverlay, false);
        overlay.appendChild(iframe);
        if (SHOW_OSD) buildOsd();
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';

        window.addEventListener('message', onMessage, false);
        window.addEventListener('blur', reclaimFocus, false);
        document.addEventListener('focus', reclaimFocus, true);
        document.addEventListener('visibilitychange', onVisibilityChange, false);
        registerMediaKeys();

        // Lampa's controller only has to know the player owns the screen.
        // Keys are handled by onKeyDown; a back from elsewhere just closes.
        Lampa.Controller.add(CONTROLLER, {
            invisible: true,
            toggle: focusOverlay,
            back: closePlayer
        });
        Lampa.Controller.toggle(CONTROLLER);
        iframe.src = url;
        focusOverlay();
        osd('Loading', '', 0);
    }

    /* ---------- series: season / episode picker ---------- */

    function readEpisodeMap() {
        try {
            var map = Lampa.Storage.get(STORE_KEY, '{}');
            if (typeof map === 'string') map = JSON.parse(map);
            return map && typeof map === 'object' ? map : {};
        } catch (e) {
            return {};
        }
    }

    function loadLastEpisode(id) {
        return readEpisodeMap()[id] || null;
    }

    function saveLastEpisode(id, season, episode) {
        try {
            var map = readEpisodeMap();
            map[id] = { s: season, e: episode };
            Lampa.Storage.set(STORE_KEY, map);
        } catch (ignored) {}
    }

    function pickEpisode(movie, returnTo, done) {
        var seasons = [];
        var list = movie.seasons || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].season_number > 0 && list[i].episode_count > 0) {
                seasons.push(list[i]);
            }
        }
        // No season data or no picker: fall back to S1E1 as before.
        if (!seasons.length || !Lampa.Select || !Lampa.Select.show) {
            done(1, 1);
            return;
        }

        var last = loadLastEpisode(movie.id) || {};

        function backToCard() {
            Lampa.Controller.toggle(returnTo);
        }

        // Let Lampa.Select finish closing before the next screen opens.
        function later(fn) {
            setTimeout(fn, 0);
        }

        function showEpisodes(season, onBack) {
            var items = [];
            for (var e = 1; e <= season.episode_count; e++) {
                items.push({
                    title: 'Episode ' + e,
                    episode: e,
                    selected: season.season_number === last.s && e === last.e
                });
            }
            Lampa.Select.show({
                title: season.name || 'Season ' + season.season_number,
                items: items,
                onSelect: function (item) {
                    later(function () { done(season.season_number, item.episode); });
                },
                onBack: onBack
            });
        }

        function showSeasons() {
            Lampa.Select.show({
                title: movie.name || movie.title || 'Seasons',
                items: seasons.map(function (season) {
                    return {
                        title: season.name || 'Season ' + season.season_number,
                        subtitle: season.episode_count + ' episodes',
                        season: season,
                        selected: season.season_number === last.s
                    };
                }),
                onSelect: function (item) {
                    later(function () { showEpisodes(item.season, showSeasons); });
                },
                onBack: backToCard
            });
        }

        if (seasons.length === 1) showEpisodes(seasons[0], backToCard);
        else showSeasons();
    }

    function start(movie) {
        var returnTo = activeControllerName();
        if (!isSeries(movie)) {
            openPlayer(movie, 0, 0, returnTo);
            return;
        }
        pickEpisode(movie, returnTo, function (season, episode) {
            saveLastEpisode(movie.id, season, episode);
            openPlayer(movie, season, episode, returnTo);
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
                version: '2.2.0',
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

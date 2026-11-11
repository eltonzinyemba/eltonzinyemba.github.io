/*
 * EltonTV / CineSrc for Lampa - 2.1.0 (Samsung TV remote edition)
 *
 * Full-viewport iframe, no custom buttons or instruction bar.
 * Remote input stays in Lampa; player commands use CineSrc postMessage API.
 *
 * Remote: OK/PlayPause = toggle playback, Left/Right = -/+ 10 seconds,
 * Up/Down = embedded-player volume +/-10%, Back = return to Lampa.
 * The TV's physical volume keys continue to be handled by the TV.
 *
 * NOTE: CineSrc is a cross-origin iframe. This does NOT provide
 * remote navigation of CineSrc's own server/episode/subtitle menus.
 */
(function () {
    'use strict';

    if (window.eltontv_cinesrc_remote_210) return;
    window.eltontv_cinesrc_remote_210 = true;

    var ORIGIN = 'https://cinesrc.st';
    var CONTROLLER = 'eltontv_cinesrc_remote';
    var overlay = null;
    var iframe = null;
    var previousController = 'content';
    var previousOverflow = '';
    var initialized = false;
    var isReady = false;
    var isPlaying = null;
    var currentTime = null;
    var duration = null;
    var pendingToggle = false;
    var pendingSeek = 0;
    var seekRequested = false;
    var pendingVolume = 0;
    var volumeRequested = false;

    function notify(message) {
        if (window.Lampa && Lampa.Noty && Lampa.Noty.show) {
            Lampa.Noty.show(message);
        }
    }

    function validTmdbId(id) {
        return /^\d+$/.test(String(id || ''));
    }

    function isSeries(movie) {
        return movie.media_type === 'tv' || movie.type === 'tv' ||
            !!movie.first_air_date || !!movie.number_of_seasons;
    }

    function makeUrl(movie) {
        if (!movie || !validTmdbId(movie.id)) return null;
        var id = encodeURIComponent(String(movie.id));
        var url = ORIGIN + '/embed/';
        if (isSeries(movie)) {
            // If a season/episode is in the Lampa data, respect it.
            var s = Number(movie.season_number || movie.season || 1);
            var e = Number(movie.episode_number || movie.episode || 1);
            if (!isFinite(s) || s < 1) s = 1;
            if (!isFinite(e) || e < 1) e = 1;
            url += 'tv/' + id + '?s=' + Math.floor(s) + '&e=' + Math.floor(e) + '&';
        } else {
            url += 'movie/' + id + '?';
        }
        // Hide the external player's standard control bar too. Remote uses API.
        return url + 'autoplay=true&controls=false&back=close';
    }

    function focusOverlay() {
        if (!overlay) return;
        try { overlay.focus({ preventScroll: true }); }
        catch (e) { try { overlay.focus(); } catch (ignored) {} }
    }

    function sendCommand(command, args) {
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

    function togglePlayback() {
        if (!overlay) return;
        if (isPlaying === null) {
            pendingToggle = true;
            sendCommand('getPaused');
        } else {
            sendCommand(isPlaying ? 'pause' : 'play');
            isPlaying = !isPlaying;
        }
        focusOverlay();
    }

    function seekBy(seconds) {
        if (!overlay) return;
        pendingSeek += seconds;
        if (currentTime !== null) {
            applySeek(currentTime);
        } else if (!seekRequested) {
            seekRequested = true;
            sendCommand('getCurrentTime');
        }
        focusOverlay();
    }

    function applySeek(start) {
        if (!pendingSeek || !isFinite(start)) return;
        var target = Math.max(0, start + pendingSeek);
        if (duration !== null) target = Math.min(duration, target);
        pendingSeek = 0;
        seekRequested = false;
        currentTime = target;
        sendCommand('seek', [target]);
    }

    function changeVolume(delta) {
        if (!overlay) return;
        pendingVolume += delta;
        if (!volumeRequested) {
            volumeRequested = true;
            sendCommand('getVolume');
        }
        focusOverlay();
    }

    function onMessage(event) {
        if (!overlay || !iframe || event.origin !== ORIGIN ||
            event.source !== iframe.contentWindow || !event.data) return;

        var data = event.data;
        switch (data.type) {
            case 'cinesrc:ready':
                isReady = true;
                sendCommand('getPaused');
                break;
            case 'cinesrc:play':
                isPlaying = true;
                break;
            case 'cinesrc:pause':
                isPlaying = false;
                break;
            case 'cinesrc:timeupdate':
            case 'cinesrc:seeked':
                if (typeof data.currentTime === 'number' && isFinite(data.currentTime)) {
                    currentTime = data.currentTime;
                }
                if (typeof data.duration === 'number' && isFinite(data.duration)) {
                    duration = data.duration;
                }
                break;
            case 'cinesrc:loadedmetadata':
                if (typeof data.duration === 'number' && isFinite(data.duration)) {
                    duration = data.duration;
                }
                break;
            case 'cinesrc:response':
                if (data.command === 'getPaused') {
                    if (typeof data.result === 'boolean') isPlaying = !data.result;
                    if (pendingToggle) {
                        pendingToggle = false;
                        // If the player has not published a state yet, first OK starts it.
                        sendCommand(isPlaying === true ? 'pause' : 'play');
                        isPlaying = isPlaying === true ? false : true;
                    }
                } else if (data.command === 'getCurrentTime') {
                    seekRequested = false;
                    if (typeof data.result === 'number' && isFinite(data.result)) {
                        currentTime = data.result;
                        applySeek(currentTime);
                    }
                } else if (data.command === 'getVolume') {
                    volumeRequested = false;
                    if (typeof data.result === 'number' && isFinite(data.result)) {
                        var level = Math.max(0, Math.min(1, data.result + pendingVolume));
                        sendCommand('setVolume', [level]);
                    }
                    pendingVolume = 0;
                }
                break;
            case 'cinesrc:close':
                closePlayer();
                break;
            case 'cinesrc:error':
                notify('CineSrc playback error. Try another title or source.');
                break;
        }
    }

    function onFrameFocus(event) {
        // Some TV web engines put focus on an iframe automatically.
        if (overlay && iframe && event.target === iframe) focusOverlay();
    }

    function stopKey(event) {
        if (event.preventDefault) event.preventDefault();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        if (event.stopPropagation) event.stopPropagation();
    }

    function onKeyDown(event) {
        if (!overlay) return;
        var code = event.keyCode || event.which;
        switch (code) {
            case 13:       // OK / Enter
            case 32:       // Space on attached keyboard
            case 10252:    // Samsung MediaPlayPause
                stopKey(event);
                togglePlayback();
                break;
            case 415:      // MediaPlay
                stopKey(event);
                sendCommand('play');
                isPlaying = true;
                break;
            case 19:       // MediaPause
                stopKey(event);
                sendCommand('pause');
                isPlaying = false;
                break;
            case 37:       // Left
            case 412:      // Rewind
                stopKey(event);
                seekBy(-10);
                break;
            case 39:       // Right
            case 417:      // FastForward
                stopKey(event);
                seekBy(10);
                break;
            case 38:       // Up
                stopKey(event);
                changeVolume(0.1);
                break;
            case 40:       // Down
                stopKey(event);
                changeVolume(-0.1);
                break;
            case 10009:    // Samsung Back
            case 461:      // Other TVs Back
            case 27:       // Escape
            case 8:        // Browser Backspace
                stopKey(event);
                closePlayer();
                break;
        }
    }

    function registerMediaKeys() {
        try {
            if (window.tizen && tizen.tvinputdevice && tizen.tvinputdevice.registerKey) {
                var names = ['MediaPlayPause', 'MediaPlay', 'MediaPause',
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

    function closePlayer() {
        if (!overlay) return;
        var old = overlay;
        var oldFrame = iframe;
        overlay = null;
        iframe = null;

        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('message', onMessage, false);
        document.removeEventListener('focus', onFrameFocus, true);
        if (oldFrame) {
            try { oldFrame.src = 'about:blank'; } catch (ignored) {}
        }
        if (old.parentNode) old.parentNode.removeChild(old);
        document.body.style.overflow = previousOverflow;

        try { Lampa.Controller.toggle(previousController); }
        catch (error) { Lampa.Controller.toggle('content'); }
    }

    function openPlayer(movie) {
        var url = makeUrl(movie);
        if (!url) {
            notify('EltonTV: invalid TMDB ID for this title.');
            return;
        }
        if (overlay) closePlayer();

        var active = Lampa.Controller.enabled && Lampa.Controller.enabled();
        previousController = typeof active === 'string' ? active :
            active && active.name ? active.name : 'content';
        previousOverflow = document.body.style.overflow;
        isReady = false;
        isPlaying = null;
        currentTime = null;
        duration = null;
        pendingToggle = false;
        pendingSeek = 0;
        seekRequested = false;
        pendingVolume = 0;
        volumeRequested = false;

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
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('message', onMessage, false);
        document.addEventListener('focus', onFrameFocus, true);
        registerMediaKeys();

        // Keep Lampa's own key controller in this player instead of the movie card.
        Lampa.Controller.add(CONTROLLER, {
            invisible: true,
            toggle: focusOverlay,
            back: closePlayer,
            ok: togglePlayback,
            enter: togglePlayback,
            left: function () { seekBy(-10); },
            right: function () { seekBy(10); },
            up: function () { changeVolume(0.1); },
            down: function () { changeVolume(-0.1); }
        });
        Lampa.Controller.toggle(CONTROLLER);
        iframe.src = url;
        focusOverlay();
    }

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
        button.on('hover:enter click', function () { openPlayer(movie); });
        buttons.append(button);
    }

    function init() {
        if (initialized || !window.Lampa || !window.jQuery) return;
        initialized = true;
        if (Lampa.Manifest) {
            Lampa.Manifest.plugins = {
                type: 'video',
                version: '2.1.0',
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

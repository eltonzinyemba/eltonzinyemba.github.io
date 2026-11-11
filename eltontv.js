
/* EltonTV / CineSrc for Lampa — 2.0.0
 * Provides a CineSrc iframe button on the movie/series details screen.
 * The iframe is NOT a direct stream and does not use Lampa.Player.
 */
(function () {
    'use strict';

    if (window.eltontv_cinesrc_v2) return;
    window.eltontv_cinesrc_v2 = true;

    var overlay = null;
    var iframe = null;
    var previousController = 'content';
    var initialized = false;

    function notify(message) {
        if (window.Lampa && Lampa.Noty) Lampa.Noty.show(message);
    }

    function makeUrl(movie) {
        var id = String(movie && movie.id || '');
        if (!/^\d+$/.test(id)) return null;

        var isTv = movie.media_type === 'tv' || movie.type === 'tv' ||
            !!movie.first_air_date || !!movie.number_of_seasons;

        // CineSrc uses TMDB IDs and an iframe embed, not a direct media URL.
        if (isTv) {
            return 'https://cinesrc.st/embed/tv/' + id +
                '?s=1&e=1&back=close&autoplay=true';
        }
        return 'https://cinesrc.st/embed/movie/' + id +
            '?back=close&autoplay=true';
    }

    function closePlayer() {
        if (!overlay) return;

        var oldOverlay = overlay;
        var oldIframe = iframe;
        overlay = null;
        iframe = null;

        window.removeEventListener('message', onMessage);
        document.removeEventListener('keydown', onKeyDown, true);

        if (oldIframe) oldIframe.attr('src', 'about:blank');
        oldOverlay.remove();
        try {
            Lampa.Controller.toggle(previousController);
        } catch (error) {
            Lampa.Controller.toggle('content');
        }
    }

    function onMessage(event) {
        if (!iframe || event.origin !== 'https://cinesrc.st' ||
            event.source !== iframe[0].contentWindow) return;

        if (event.data && event.data.type === 'cinesrc:close') {
            closePlayer();
        } else if (event.data && event.data.type === 'cinesrc:error') {
            notify('CineSrc reported a playback error.');
        }
    }

    function onKeyDown(event) {
        var key = event.keyCode || event.which;
        if (key === 10009 || key === 27 || key === 8 || key === 461) {
            event.preventDefault();
            event.stopPropagation();
            closePlayer();
        }
    }

    function openPlayer(movie) {
        var url = makeUrl(movie);
        if (!url) {
            notify('EltonTV: this title has no valid TMDB ID.');
            return;
        }
        if (overlay) closePlayer();

        var active = Lampa.Controller.enabled && Lampa.Controller.enabled();
        previousController = active && active.name ? active.name : 'content';

        var title = movie.title || movie.name || 'CineSrc';
        var close = $('<div class="eltontv-close selector" tabindex="0">Close (Back)</div>');
        var focus = $('<div class="eltontv-focus selector" tabindex="0">Focus player (OK)</div>');
        var label = $('<div class="eltontv-title"></div>').text(title);
        var toolbar = $('<div class="eltontv-toolbar"></div>');
        iframe = $('<iframe title="CineSrc player" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen="allowfullscreen"></iframe>');
        overlay = $('<div class="eltontv-overlay"></div>');

        overlay.css({position:'fixed',top:0,left:0,width:'100%',height:'100%',
            zIndex:999999,background:'#000',display:'flex',flexDirection:'column'});
        toolbar.css({height:'54px',minHeight:'54px',display:'flex',alignItems:'center',
            padding:'0 14px',background:'#171717',color:'#fff',gap:'14px',fontSize:'18px'});
        label.css({flex:'1',overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis'});
        close.add(focus).css({padding:'8px 12px',background:'#333',borderRadius:'6px',
            cursor:'pointer',whiteSpace:'nowrap',marginLeft:'10px'});
        iframe.css({width:'100%',height:'calc(100% - 54px)',flex:'1',border:'0',background:'#000'});

        close.on('hover:enter click', closePlayer);
        focus.on('hover:enter click', function () { iframe[0].focus(); });
        toolbar.append(label, focus, close);
        overlay.append(toolbar, iframe);
        $('body').append(overlay);

        window.addEventListener('message', onMessage);
        document.addEventListener('keydown', onKeyDown, true);

        Lampa.Controller.add('eltontv_cinesrc_player', {
            invisible: true,
            toggle: function () { close.focus(); },
            back: closePlayer,
            up: function () { close.focus(); },
            down: function () { iframe[0].focus(); },
            left: function () { close.focus(); },
            right: function () { iframe[0].focus(); },
            enter: function () { iframe[0].focus(); },
            ok: function () { iframe[0].focus(); }
        });
        Lampa.Controller.toggle('eltontv_cinesrc_player');
        iframe.attr('src', url);
    }

    function addButton(event) {
        if (!event || event.type !== 'complite' || !event.object ||
            !event.object.activity || !event.object.activity.render) return;

        var movie = event.data && event.data.movie;
        if (!movie || !movie.id) return;

        var screen = event.object.activity.render();
        var buttons = screen.find('.full-start-new__buttons, .full-start__buttons').first();
        if (!buttons.length || buttons.find('.view--eltontv').length) return;

        var button = $('<div class="full-start__button full-start-new__button selector view--eltontv"><span>CineSrc</span></div>');
        button.on('hover:enter click', function () { openPlayer(movie); });
        buttons.append(button);
    }

    function init() {
        if (initialized || !window.Lampa || !window.jQuery) return;
        initialized = true;
        if (Lampa.Manifest) {
            Lampa.Manifest.plugins = {
                type: 'video',
                version: '2.0.0',
                name: 'EltonTV (CineSrc)',
                description: 'CineSrc iframe player for Lampa movie and TV details'
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

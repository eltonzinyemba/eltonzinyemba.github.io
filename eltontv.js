(function () {
    'use strict';

    function startPlugin() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') {
                var render = e.object.activity.render();
                var movie = e.data.movie;
                if (!movie || !movie.id) return;

                var btn = $('<div class="full-start__button selector view--cinesrc"><span>CineSrc</span></div>');

                btn.on('hover:enter', function () {
                    var isTv = !!movie.first_air_date || !!movie.number_of_seasons;
                    var url = isTv
                        ? 'https://cinesrc.st/embed/tv/' + movie.id + '?s=1&e=1'
                        : 'https://cinesrc.st/embed/movie/' + movie.id;

                    window.open(url, '_blank');
                });

                render.find('.full-start__buttons').append(btn);
            }
        });
    }

    if (window.appready) startPlugin();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') startPlugin();
        });
    }
})();

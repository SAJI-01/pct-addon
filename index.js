var _ = require("lodash");
var async = require("async");
var needle = require("needle");
var fs = require('fs');
var path = require('path');

var manifest = {
    "name": "Popcorn Time",
    "description": "Watch from YTS and EZTV in Stremio",
    "id": "org.jcb9090.popcorn",
    "version": "1.0.0",
    "types": ["movie", "series"],
    "contactEmail": "JBC9090@tuta.io",
    "endpoint": "https://pct-addon-production.up.railway.app",
    "background": "https://raw.githubusercontent.com/butterproject/butter-desktop/master/src/app/images/bg-header.jpg"
};

process.on("uncaughtException", function(err) {
    console.error("UNCAUGHT EXCEPTION", err);
});

process.on("unhandledRejection", function(err) {
    console.error("UNHANDLED REJECTION", err);
});

/* CACHE */
var cachePath = path.join(process.env.HOME || require("os").tmpdir(), "popcorn-cache.json");
var map = {};
try { map = JSON.parse(fs.readFileSync(cachePath).toString()); } catch(e) { console.error("non-fatal (cache)", e.message); }
console.log("-> map has " + Object.keys(map).length + " movies / eps");
map.topPages = map.topPages || [];

/* HTTP SERVER */
var server = require("http").createServer(function(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", "application/json");

    var url = req.url.split("?")[0];
    console.log("-> request: " + url);

    // Manifest
    if (url === "/" || url === "/stremio/v1/manifest.json") {
        res.writeHead(200);
        return res.end(JSON.stringify(manifest));
    }

    // Stream find - GET with query params
    if (url === "/stremio/v1/stream.find.json") {
        var qs = require("querystring").parse(req.url.split("?")[1] || "");
        var query = {};
        try { query = JSON.parse(qs.query || "{}"); } catch(e) {}

        var isEp = query.hasOwnProperty("season");
        var hash = (isEp ? [query.imdb_id, query.season, query.episode] : [query.imdb_id]).join(" ");
        var streams = _.map(map[hash] || [], function(infoHash, quality) {
            return {
                infoHash: infoHash.toLowerCase(),
                name: isEp ? "EZTV" : "YTS",
                title: quality,
                isFree: true,
                sources: [
                    "tracker:udp://tracker.leechers-paradise.org:6969/announce",
                    "tracker:udp://tracker.pomf.se:80/announce",
                    "tracker:udp://tracker.opentrackr.org:1337/announce"
                ],
                availability: 2
            };
        });
        res.writeHead(200);
        return res.end(JSON.stringify({ result: streams }));
    }

    // Meta find
    if (url === "/stremio/v1/meta.find.json") {
        var results = _.flatten(map.topPages)
            .slice(0, 200)
            .sort(function(b, a) { return a.popularities.yts - b.popularities.yts });
        res.writeHead(200);
        return res.end(JSON.stringify({ result: results }));
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found", url: url }));
});

/* COLLECT DATA */
var httpOpts = {
    headers: { user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/28.0.1500.52 Safari/537.36" },
    json: true,
    open_timeout: 15000,
    timeout: 15000,
    read_timeout: 15000
};

var ezQueue = async.queue(collector, 1);
var ytsQueue = async.queue(collector, 1);

function collector(url, next) {
    console.log("-> collecting from " + url);
    needle.get(url, httpOpts, function(err, resp, body) {
        process.nextTick(next);
        if (err) { console.error("Request failed:", url, err.message); return; }
        if (!resp) { console.error("No response:", url); return; }
        try {
            if (Array.isArray(body) && body[0] && typeof(body[0]) === "string" && body[0].match("shows")) {
                body.forEach(function(page) { ezQueue.push(url.replace('/shows/', '/' + page)); });
            }
            if (Array.isArray(body) && body[0] && body[0].tvdb_id) {
                body.reverse().forEach(function(show) { ezQueue.push(url.split('/shows')[0] + '/show/' + show._id); });
            }
            if (body && body._id && body.imdb_id && body.tvdb_id) { indexShow(body); }
            if (body && body.status && body.data && body.data.movies) {
                body.data.movies.forEach(indexMovie);
                if (body.data.page_number < 10)
                    map.topPages[body.data.page_number] = body.data.movies.map(mapMetaToStremio);
                if (body.data.page_number * body.data.limit < body.data.movie_count)
                    ytsQueue.push(url.split("?")[0] + "?page=" + (body.data.page_number + 1));
            }
        } catch(e) { console.error("Collector error:", e); }
    });
}

var sources = require("./sources");
if (!process.env.DISABLE_IDX) sources.yts.forEach(function(url) { ytsQueue.push(url); });
if (!process.env.DISABLE_IDX) async.eachSeries(sources.eztv, function(url, cb) {
    needle.get(url, httpOpts, function(err, resp, body) {
        if (body && body[0] && typeof(body[0]) === "string") { ezQueue.push(url); cb(true); }
        else cb();
    });
}, function() {});

/* INDEX FUNCTIONS */
function indexMovie(movie) {
    if (movie && Array.isArray(movie.torrents)) movie.torrents.forEach(function(t) {
        if (!map[movie.imdb_code]) map[movie.imdb_code] = {};
        map[movie.imdb_code][t.quality] = t.hash;
    });
}

function indexShow(show) {
    if (!(show && show.imdb_id && show.episodes && Array.isArray(show.episodes))) return;
    show.episodes.forEach(function(ep) {
        var hash = show.imdb_id + " " + ep.season + " " + ep.episode;
        if (!map[hash]) map[hash] = {};
        _.each(ep.torrents, function(tor, quali) {
            try { map[hash][quali] = magnet.decode(tor.url).infoHash; } catch(e) {}
        });
        var m = map[hash];
        if (m['0'] && (m['1080p'] == m['0'] || m['720p'] == m['0'] || m['480p'] == m['0'])) delete m['0'];
    });
}

function mapMetaToStremio(m) {
    return {
        imdb_id: m.imdb_code,
        name: m.title,
        year: m.year,
        runtime: m.runtime,
        rating: m.rating,
        genre: m.genres,
        description: m.summary,
        poster: m.medium_cover_image,
        type: "movie",
        popularities: { yts: m.torrents[0].seeds }
    };
}

/* SAVE CACHE */
setInterval(function() {
    var start = Date.now();
    var n = Object.keys(map).length;
    fs.writeFile(cachePath, JSON.stringify(map), function(e) { if (e) console.error(e); });
    console.log("-> cache saved in " + (Date.now() - start) + "ms for " + n + " items");
}, 30 * 1000);

/* START */
var PORT = process.env.PORT || 7821;
server.listen(PORT, function() {
    console.log("Addon running at port " + PORT);
});
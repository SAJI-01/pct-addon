var _ = require("lodash");
var async = require("async");
var needle = require("needle");
var fs = require('fs');
var path = require('path');

var manifest = {
    name: "Popcorn Time",
    description: "Watch YTS Movies in Stremio",
    id: "org.jcb9090.popcorn",
    version: "1.0.0",
    types: ["movie"],
    contactEmail: "JBC9090@tuta.io",
    endpoint: "https://pct-addon-production.up.railway.app",
    background: "https://raw.githubusercontent.com/butterproject/butter-desktop/master/src/app/images/bg-header.jpg"
};

process.on("uncaughtException", function(err) { console.error("UNCAUGHT EXCEPTION", err); });
process.on("unhandledRejection", function(err) { console.error("UNHANDLED REJECTION", err); });

var cachePath = path.join(process.env.HOME || require("os").tmpdir(), "popcorn-cache.json");
var map = {};
try { map = JSON.parse(fs.readFileSync(cachePath).toString()); } catch(e) { console.error("non-fatal (cache)", e.message); }
console.log("-> map has " + Object.keys(map).length + " movies");
map.topPages = map.topPages || [];

var server = require("http").createServer(function(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", "application/json");
    var url = req.url.split("?")[0];
    console.log("-> request: " + url);

    if (
        url === "/" ||
        url === "/manifest.json" ||
        url === "/stremio/v1/manifest.json"
    ){
        res.writeHead(200);
        return res.end(JSON.stringify(manifest));
    }

    if (url === "/stremio/v1/stream.find.json") {
        var qs = require("querystring").parse(req.url.split("?")[1] || "");
        var query = {};

        try {
            query = JSON.parse(qs.query || "{}");
        } catch(e) {}

        var streams = _.map(map[query.imdb_id] || {}, function(infoHash, quality) {
            return {
                infoHash: infoHash.toLowerCase(),
                name: "YTS",
                title: quality,
                isFree: true,
                sources: [
                    "tracker:udp://tracker.opentrackr.org:1337/announce",
                    "tracker:udp://tracker.leechers-paradise.org:6969/announce"
                ],
                availability: 2
            };
        });

        res.writeHead(200);
        return res.end(JSON.stringify({ result: streams }));
    }

    if (url === "/stremio/v1/meta.find.json") {
        var results = _.flatten(map.topPages).slice(0, 200).sort(function(b, a) { return a.popularities.yts - b.popularities.yts; });
        res.writeHead(200);
        return res.end(JSON.stringify({ result: results }));
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found", url: url }));
});

var httpOpts = {
    headers: {
        "User-Agent": "Mozilla/5.0"
    },
    json: true,
    open_timeout: 15000,
    timeout: 15000,
    read_timeout: 15000
};
var queue = async.queue(collector, 1);

function collector(url, next) {
    console.log("-> collecting from " + url);

    needle.get(url, httpOpts, function(err, resp, body) {
        process.nextTick(next);

        if (err) {
            console.error("Request failed:", err.message);
            return;
        }

        if (!resp) {
            console.error("No response");
            return;
        }

        console.log("STATUS:", resp.statusCode);

        try {
            if (body && body.status && body.data && body.data.movies) {

                console.log(
                    "Indexed page",
                    body.data.page_number,
                    "movies:",
                    body.data.movies.length
                );

                body.data.movies.forEach(indexMovie);

                if (body.data.page_number < 10) {
                    map.topPages[body.data.page_number] =
                        body.data.movies.map(mapMetaToStremio);
                }

                if (
                    body.data.page_number *
                    body.data.limit <
                    body.data.movie_count
                ) {
                    queue.push(
                        url.split("?")[0] +
                        "?page=" +
                        (body.data.page_number + 1)
                    );
                }
            } else {
                console.log(
                    "Unexpected response:",
                    JSON.stringify(body).slice(0, 500)
                );
            }
        }
        catch (e) {
            console.error("Collector error:", e);
        }
    });
}

var sources = require("./sources");

if (!process.env.DISABLE_IDX) {
    sources.yts.forEach(function(url) {
        queue.push(url);
    });
}

function indexMovie(movie) {
    if (movie && Array.isArray(movie.torrents)) movie.torrents.forEach(function(t) {
        if (!map[movie.imdb_code]) map[movie.imdb_code] = {};
        map[movie.imdb_code][t.quality] = t.hash;
    });
}

function mapMetaToStremio(m) {
    return { imdb_id: m.imdb_code, name: m.title, year: m.year, runtime: m.runtime, rating: m.rating,
        genre: m.genres, description: m.summary, poster: m.medium_cover_image, type: "movie",
        popularities: {
            yts: (m.torrents && m.torrents.length)
                ? m.torrents[0].seeds
                : 0
        } };
}

setInterval(function() {
    var n = Object.keys(map).filter(function(k) {
        return k !== "topPages";
    }).length;
    fs.writeFile(cachePath, JSON.stringify(map), function(e) { if (e) console.error(e); });
    console.log("-> cache saved for " + n + " items");
}, 30 * 1000);

var PORT = process.env.PORT || 7821;
server.listen(PORT, function() { console.log("Addon running at port " + PORT); });

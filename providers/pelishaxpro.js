/*
 * PelisHaxPro provider for Nuvio
 * Flow: TMDB ID -> PelisHaxPro page -> Spanish Latino servers -> StreamWish / VidHide decoders.
 * Runtime dependencies provided by Nuvio: fetch.
 *
 * CONFIGURATION:
 * ENABLE_VIDHIDE = true  -> publishes StreamWish and VidHide (default).
 * ENABLE_VIDHIDE = false -> publishes StreamWish only.
 */

const PROVIDER_NAME = 'PelisHaxPro';
// Interruptor de proveedor: true = habilitar VidHide; false = solo StreamWish.
const ENABLE_VIDHIDE = false;
const PELIHAX_BASE = 'https://pelishaxpro.com';
const PELIHAX_REFERER = PELIHAX_BASE + '/';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

function log(message) {
  console.log('[PelisHaxPro] ' + message);
}

function safeUrl(value) {
  try {
    var match = String(value || '').match(/^(https?:\/\/[^/]+)(\/[^?#]*)?/i);
    return match ? match[1] + (match[2] || '') : String(value || '');
  } catch (_) {
    return String(value || '');
  }
}

function fetchText(url, headers) {
  return fetch(url, {
    method: 'GET',
    headers: Object.assign({
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
    }, headers || {})
  }).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status + ' en ' + safeUrl(url));
    return response.text().then(function (text) {
      return { response: response, text: text };
    });
  });
}

function unpackPacked(html) {
  var output = [];
  var regex = /\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
  var match;
  while ((match = regex.exec(String(html || '')))) {
    var radix = parseInt(match[2], 10);
    var count = parseInt(match[3], 10);
    var words = match[4].split('|');
    var payload = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    if (!(radix >= 2 && radix <= 62) || count > 50000) continue;
    function encode(number) {
      var quotient = Math.floor(number / radix);
      var remainder = number % radix;
      var prefix = number < radix ? '' : encode(quotient);
      return prefix + (remainder > 35 ? String.fromCharCode(remainder + 29) : remainder.toString(36));
    }
    var dict = Object.create(null);
    while (count--) dict[encode(count)] = words[count] || encode(count);
    output.push(payload.replace(/\b\w+\b/g, function (word) {
      return Object.prototype.hasOwnProperty.call(dict, word) ? dict[word] : word;
    }));
  }
  return output.join('\n');
}

function extractPlaylists(html) {
  var htmlText = String(html || '');
  var source = htmlText + '\n' + unpackPacked(htmlText);
  var playlists = [];
  var seenPlaylists = new Set();
  function add(value) {
    if (typeof value !== 'string') return;
    var url = value.replace(/\\\//g, '/').trim();
    if (url.charAt(0) === '/' && url.slice(0, 2) !== '//') {
      url = 'https://morencius.com' + url;
    }
    if (/^https:\/\//i.test(url) && /\.m3u8(?:\?|$)/i.test(url) && !seenPlaylists.has(url)) {
      seenPlaylists.add(url);
      playlists.push(url);
    }
  }
  var links = /links\s*=\s*(\{[^{}]*\})/.exec(source);
  if (links) {
    try {
      var config = JSON.parse(links[1]);
      ['hls4', 'hls3', 'hls2'].forEach(function (key) { add(config[key]); });
    } catch (_) {}
  }
  var fileRegex = /(?:file|src)\s*:\s*["']([^"']+)\s*["']/g;
  var match;
  while ((match = fileRegex.exec(source))) add(match[1]);
  return playlists;
}


// Decodifica entidades comunes presentes en data-link y en los atributos de idioma.
function decodeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);?/g, function (_, number) {
      var code = Number(number);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);?/gi, function (_, hex) {
      var code = parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    });
}

function parseHtmlAttributes(tag) {
  var attrs = Object.create(null);
  var body = String(tag || '').replace(/^<[a-z][^\s/>]*/i, '').replace(/>$/, '');
  var regex = /([^\s=\/'"<>`]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  var match;
  while ((match = regex.exec(body))) {
    var key = String(match[1] || '').toLowerCase();
    var value = match[2] != null ? match[2] : match[3] != null ? match[3] : match[4];
    attrs[key] = decodeHtml(value);
  }
  return attrs;
}

function compactLanguage(value) {
  return String(value == null ? '' : value).trim().toLowerCase()
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ü/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]/g, '');
}

function hasMexicoFlag(context) {
  return /mexico|m[eé]xico|bandera\s+de\s+m[eé]xico|(?:flag|fi)(?:[-_][a-z]+)*[-_]mx|country[-_]?mx|data-country\s*=\s*[\"']?mx|(?:^|[\/_ .-])mx(?:[\/_ .-]|$)|🇲🇽/i.test(String(context || ''));
}

// Solo considera latino si el idioma lo indica expresamente o ESP/español genérico
// aparece acompañado por la bandera/identificador de México. Castellano nunca entra.
function isLatinSpanish(language, context) {
  var lang = compactLanguage(language);
  if (!lang) return hasMexicoFlag(context);

  if (/castellano|espana|espanadeespana|spanishspain|europeanspanish|eses/.test(lang)) return false;

  if ([
    'lat', 'latino', 'latina', 'latam', 'latin', 'latinspanish', 'spanishlatin',
    'espanollatino', 'espanollatinoamericano', 'espanollatinoamericana',
    'es419', 'esla', 'esmx', 'esar', 'escl', 'esco', 'espe', 'mexicanspanish'
  ].indexOf(lang) !== -1 || /latino|latina|latam|latinspanish|spanishlatin/.test(lang) ||
      /^es(?:419|la|mx|ar|cl|co|pe|bo|ec|uy|py|ve|gt|cr|pa|do|hn|sv|ni|cu|pr)$/.test(lang)) {
    return true;
  }

  // Algunos listados usan ESP como código común, pero PelisHax identifica la pista
  // latino con la bandera de México. No aceptar ESP/español genérico sin esa señal.
  if (['esp', 'es', 'espanol', 'spanish', 'espanolneutro'].indexOf(lang) !== -1) {
    return hasMexicoFlag(context);
  }
  return false;
}

function resolveServerUrl(value) {
  var url = decodeHtml(value).replace(/\\\//g, '/').trim();
  if (!url) return null;
  try {
    if (url.indexOf('//') === 0) return 'https:' + url;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.charAt(0) === '/') return PELIHAX_BASE + url;
  } catch (_) {}
  return null;
}

function getServerProvider(url) {
  // La asignación del decoder se hace exclusivamente por el host de data-link.
  // No se usa el texto visible (FWISH/FHIDE), porque puede variar o venir
  // mezclado con etiquetas cercanas en el HTML.
  var host = '';
  try {
    var match = String(url).match(/^https?:\/\/([^/:?#]+)/i);
    host = match ? match[1].toLowerCase() : '';
  } catch (_) {}

  if (/(^|\.)streamwish\.(?:to|com|net|io)$/.test(host) ||
      /(^|\.)wishfast\.(?:top|com)$/.test(host) ||
      /(^|\.)hglink\.to$/.test(host) || /(^|\.)vibuxer\.com$/.test(host)) {
    return 'streamwish';
  }
  if (/(^|\.)vidhide(?:vip)?\.(?:com|net|to)$/.test(host)) {
    return 'vidhide';
  }
  return null;
}

// PelisHaxPro entrega cada servidor como un elemento .server-item con data-link y
// data-lang. Se analiza el atributo completo sin depender del orden de sus campos.
function extractPelisHaxServers(html) {
  var source = String(html || '');
  var tags = [];
  var tagRegex = /<[a-z][^<>]*>/gi;
  var match;
  while ((match = tagRegex.exec(source))) {
    var attrs = parseHtmlAttributes(match[0]);
    var classes = String(attrs['class'] || '').split(/\s+/);
    if (classes.indexOf('server-item') === -1) continue;
    tags.push({ start: match.index, end: tagRegex.lastIndex, tag: match[0], attrs: attrs });
  }

  var servers = [];
  var seen = Object.create(null);
  tags.forEach(function (item, index) {
    var nextStart = index + 1 < tags.length ? tags[index + 1].start : source.length;
    var attrs = item.attrs;
    var language = attrs['data-lang'] || attrs['data-language'] || attrs['data-audio'] || attrs['lang'] || '';
    // data-lang de PelisHaxPro identifica explícitamente la pista. Para aceptar
    // español genérico (ESP) se exige una señal México dentro del propio elemento.
    var inner = source.slice(item.end, Math.min(nextStart, item.end + 5000));
    var context = Object.keys(attrs).map(function (key) { return key + '=' + attrs[key]; }).join(' ') + ' ' + inner;
    if (!isLatinSpanish(language, context)) return;

    var rawUrl = attrs['data-link'] || attrs['data-url'] || attrs['href'] || '';
    var url = resolveServerUrl(rawUrl);
    if (!url || !/^https?:\/\//i.test(url)) return;

    // Una URL de StreamWish nunca se envía al decoder VidHide y viceversa.
    var provider = getServerProvider(url);
    if (!provider || seen[url]) return;
    seen[url] = true;
    servers.push({ provider: provider, url: url, lang: 'LAT' });
  });
  return servers;
}

function buildPelisHaxUrl(tmdbId, mediaType, season, episode) {
  var id = String(tmdbId == null ? '' : tmdbId).trim();
  if (!/^\d+$/.test(id)) throw new Error('TMDB ID inválido.');
  if (mediaType === 'movie') return PELIHAX_BASE + '/movies/' + encodeURIComponent(id);

  var s = Number(season);
  var e = Number(episode);
  if (!Number.isInteger(s) || s < 0 || !Number.isInteger(e) || e < 1) {
    throw new Error('Temporada y episodio son obligatorios para series.');
  }
  return PELIHAX_BASE + '/tv/' + encodeURIComponent(id) + '/' + s + '/' + e;
}

// Parser activo de StreamWish: consulta HLS4 primero y conserva los fallbacks HLS.
function makeStreamwishStream(playlist, language, mediaType) {
  var headers = {
    'User-Agent': UA,
    'Referer': playlist.referer || 'https://vibuxer.com/',
    'Origin': playlist.origin || 'https://vibuxer.com'
  };
  var quality = playlist.quality || 'Auto';
  return {
    name: PROVIDER_NAME,
    title: '',
    url: playlist.url,
    quality: '📺 StreamWish\n' + quality + ' | HLS | ' + (mediaType === 'tv' ? 'Serie' : 'Película') + '\n' + languageLabel(language),
    headers: headers,
    type: 'hls'
  };
}

// Lee el manifiesto maestro y reproduce el comportamiento esencial de M3u8Helper:
// expone las variantes de calidad como streams separados, sin cambiar las extensiones
// .txt que usa el CDN ni construir URLs de manifiesto que no existen.
function parseStreamwishMaster(text, masterUrl) {
  var lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(function (line) { return line.trim(); });
  if (!lines.some(function (line) { return line === '#EXTM3U'; })) return [];
  var variants = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
    var info = lines[i];
    var path = '';
    for (var j = i + 1; j < lines.length; j++) {
      if (!lines[j] || lines[j].charAt(0) === '#') continue;
      path = lines[j];
      break;
    }
    if (!path) continue;
    var absolute;
    try { absolute = new URL(path, masterUrl).toString(); }
    catch (_) { continue; }
    var resolution = /RESOLUTION=\d+x(\d+)/i.exec(info);
    var height = resolution ? Number(resolution[1]) : 0;
    if (!height) {
      var bandwidth = /(?:AVERAGE-BANDWIDTH|BANDWIDTH)=(\d+)/i.exec(info);
      if (bandwidth) {
        var bps = Number(bandwidth[1]);
        height = bps >= 4500000 ? 1080 : bps >= 1800000 ? 720 : bps >= 700000 ? 480 : 0;
      }
    }
    var quality = height >= 1000 ? '1080p' : height >= 700 ? '720p' : height >= 450 ? '480p' : 'Auto';
    variants.push({ url: absolute, quality: quality, height: height });
  }
  variants.sort(function (a, b) { return b.height - a.height; });
  var seen = new Set();
  return variants.filter(function (variant) {
    if (seen.has(variant.url)) return false;
    seen.add(variant.url);
    return true;
  });
}

function streamwishCandidates(links, pageUrl) {
  var pageOriginMatch = String(pageUrl || '').match(/^(https?:\/\/[^/]+)/i);
  var pageOrigin = pageOriginMatch ? pageOriginMatch[1] : 'https://vibuxer.com';
  function resolve(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    var url = value.trim().replace(/\\\//g, '/');
    if (/^https?:\/\//i.test(url)) return url;
    if (url.indexOf('//') === 0) return 'https:' + url;
    if (url.charAt(0) === '/') return pageOrigin + url;
    return pageOrigin + '/' + url;
  }
  // HLS4 es la fuente principal ya validada en reproducción; luego HLS3 y HLS2.
  // Los tres pasan por el mismo parser de variantes, respetando la extensión original.
  return [
    { url: resolve(links.hls4), key: 'hls4' },
    { url: resolve(links.hls3), key: 'hls3' },
    { url: resolve(links.hls2), key: 'hls2' }
  ].filter(function (item) {
    return item.url && /^https?:\/\//i.test(item.url) && /(?:master\.(?:m3u8|txt)|\.m3u8)(?:\?|$)/i.test(item.url);
  }).map(function (item) {
    return { url: item.url, key: item.key, origin: pageOrigin, referer: pageUrl };
  });
}

function resolveStreamwishStreams(html, pageUrl) {
  var htmlText = String(html || '');
  var source = htmlText + '\n' + unpackPacked(htmlText);
  var linksMatch = /links\s*=\s*(\{[^{}]*\})/.exec(source);
  if (!linksMatch) return Promise.resolve([]);
  var links;
  try { links = JSON.parse(linksMatch[1].replace(/\\\//g, '/')); }
  catch (_) { return Promise.resolve([]); }

  var candidates = streamwishCandidates(links, pageUrl);
  function tryCandidate(index) {
    if (index >= candidates.length) return Promise.resolve([]);
    var candidate = candidates[index];
    return fetchText(candidate.url, {
      'Referer': candidate.referer,
      'Origin': candidate.origin,
      'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*'
    }).then(function (result) {
      var body = result.text || '';
      if (!/^\s*#EXTM3U\b/m.test(body)) throw new Error('Respuesta sin #EXTM3U');
      log('StreamWish ' + candidate.key + ': manifiesto recibido; analizando variantes.');
      var variants = parseStreamwishMaster(body, candidate.url);
      if (!variants.length) {
        // Una lista multimedia directa no declara resoluciones seleccionables; se omite
        // para cumplir el modo de calidad limitada a 1080p y 720p.
        if (/^\s*#EXTINF:/m.test(body)) throw new Error('Lista directa sin variantes 1080p/720p');
        throw new Error('Manifiesto maestro sin variantes');
      }
      // Solo publicar 1080p y 720p. Si el mirror no ofrece ninguna de ellas,
      // se prueba el siguiente HLS en vez de mostrar 480p o Auto.
      variants = variants.filter(function (variant) {
        return variant.quality === '1080p' || variant.quality === '720p';
      });
      if (!variants.length) throw new Error('No ofrece variantes 1080p/720p');
      log('StreamWish ' + candidate.key + ' HTTP 200; variantes HLS 1080p/720p: ' + variants.length);
      return variants.map(function (variant) {
        return {
          url: variant.url,
          quality: variant.quality,
          origin: candidate.origin,
          referer: candidate.referer
        };
      });
    }).catch(function (error) {
      log('StreamWish ' + candidate.key + ' no disponible: ' + error.message);
      return tryCandidate(index + 1);
    });
  }
  return tryCandidate(0);
}

function streamwishPageUrl(value) {
  var url = String(value || '');
  // Algunos listados usan hglink.to como alias de la página StreamWish.
  if (/^https?:\/\/hglink\.to\//i.test(url)) return url.replace(/^https?:\/\/hglink\.to/i, 'https://vibuxer.com');
  return url;
}


function languageLabel(language) {
  return String(language || '').toUpperCase() === 'ENG' ? '🇺🇸 Inglés' : '🇲🇽 Latino';
}

function makeStream(url, language, mediaType) {
  var isMorencius = /^https:\/\/morencius\.com\//i.test(url);
  var headers = {
    'User-Agent': UA,
    'Referer': 'https://morencius.com/'
  };
  if (!isMorencius) headers.Origin = 'https://morencius.com';
  return {
    name: PROVIDER_NAME,
    title: '',
    url: url,
    quality: '📺 VidHide\nAuto | WEB-DL | ' + (mediaType === 'tv' ? 'Serie' : 'Película') + '\n' + languageLabel(language),
    headers: headers,
    type: 'hls'
  };
}

function resolveStreamwishSources(languageSources, language, mediaType) {
  var pages = [];
  var seenPages = new Set();
  (languageSources || []).forEach(function (source) {
    var pageUrl = streamwishPageUrl(source.url);
    if (!seenPages.has(pageUrl)) {
      seenPages.add(pageUrl);
      pages.push({ url: pageUrl });
    }
  });

  // Los mirrors StreamWish se prueban en serie y se detiene al encontrar uno funcional.
  // Así se evita esperar a mirrors que agotan el tiempo de espera.
  function tryPage(index) {
    if (index >= pages.length) return Promise.resolve([]);
    var item = pages[index];
    return fetchText(item.url, {
      'Referer': PELIHAX_REFERER,
      'Accept': 'text/html,application/xhtml+xml'
    }).then(function (page) {
      // StreamWish puede redirigir a un mirror rotativo (por ejemplo niramirus.com).
      // Las rutas relativas y los encabezados HLS deben usar el host final, no el alias.
      var finalPageUrl = page.response && page.response.url ? page.response.url : item.url;
      log('StreamWish embed final: ' + safeUrl(finalPageUrl));
      return resolveStreamwishStreams(page.text, finalPageUrl);
    }).then(function (playlists) {
      if (!playlists.length) {
        log('StreamWish sin variantes; se prueba el siguiente mirror: ' + safeUrl(item.url));
        return tryPage(index + 1);
      }
      var streams = [];
      var seenUrls = new Set();
      playlists.forEach(function (playlist) {
        if (!playlist || !playlist.url || seenUrls.has(playlist.url)) return;
        seenUrls.add(playlist.url);
        streams.push(makeStreamwishStream(playlist, language, mediaType));
      });
      if (!streams.length) return tryPage(index + 1);
      log('StreamWish: se selecciona el primer mirror válido (' + streams.length + ' variante(s)); se omiten los restantes.');
      return streams;
    }).catch(function (error) {
      log('Fallo leyendo StreamWish ' + safeUrl(item.url) + ': ' + error.message);
      return tryPage(index + 1);
    });
  }
  return tryPage(0);
}

function resolveVidHideSources(languageSources, language, mediaType) {
  var pages = [];
  var seenPages = new Set();
  (languageSources || []).forEach(function (source) {
    if (!seenPages.has(source.url)) {
      seenPages.add(source.url);
      pages.push(source.url);
    }
  });

  // Mantiene el extractor VidHide existente y consulta sus páginas en paralelo.
  return Promise.all(pages.map(function (pageUrl) {
    return fetchText(pageUrl, {
      'Referer': PELIHAX_REFERER,
      'Accept': 'text/html,application/xhtml+xml'
    }).then(function (page) {
      log('VidHide ' + safeUrl(pageUrl) + ' -> HTTP 200');
      return extractPlaylists(page.text);
    }).catch(function (error) {
      log('Fallo leyendo VidHide ' + safeUrl(pageUrl) + ': ' + error.message);
      return [];
    });
  })).then(function (playlistGroups) {
    var streams = [];
    var seenUrls = new Set();
    playlistGroups.forEach(function (playlists) {
      playlists.forEach(function (playlist) {
        if (seenUrls.has(playlist)) return;
        seenUrls.add(playlist);
        streams.push(makeStream(playlist, language, mediaType));
      });
    });
    return streams;
  });
}

function streamQualityRank(stream) {
  var label = String(stream && (stream.quality || stream.title) || '');
  var match = /(?:^|\b)(2160|1440|1080|720|576|540|480|360|240)p\b/i.exec(label);
  if (match) return Number(match[1]);
  return 0;
}

function combineProviderStreams(streamwishStreams, vidhideStreams) {
  var combined = [];
  var seen = new Set();
  // Orden explícito de catálogo: StreamWish primero, VidHide después.
  // Dentro de cada proveedor, mostrar primero la resolución más alta.
  (streamwishStreams || []).concat(vidhideStreams || []).forEach(function (stream) {
    if (!stream || !stream.url) return;
    // Deduplicar dentro de cada decoder, nunca entre StreamWish y VidHide.
    var provider = /VidHide/i.test(String(stream.quality || '')) ? 'vidhide' : 'streamwish';
    var key = provider + '|' + stream.url;
    if (seen.has(key)) return;
    seen.add(key);
    combined.push(stream);
  });
  var providerRank = function (stream) {
    var label = String(stream && stream.quality || '');
    return /StreamWish/i.test(label) ? 0 : /VidHide/i.test(label) ? 1 : 2;
  };
  return combined.map(function (stream, index) {
    return { stream: stream, index: index, provider: providerRank(stream), quality: streamQualityRank(stream) };
  }).sort(function (a, b) {
    return a.provider - b.provider || b.quality - a.quality || a.index - b.index;
  }).map(function (item) { return item.stream; });
}

function getStreams(tmdbId, mediaType, season, episode) {
  var type = String(mediaType || '').toLowerCase();
  if (type !== 'movie' && type !== 'tv') return Promise.resolve([]);

  var pageUrl;
  try {
    pageUrl = buildPelisHaxUrl(tmdbId, type, season, episode);
  } catch (error) {
    log(error.message);
    return Promise.resolve([]);
  }

  log('GET ' + safeUrl(pageUrl));
  return fetchText(pageUrl, {
    'Referer': PELIHAX_REFERER,
    'Accept': 'text/html,application/xhtml+xml'
  }).then(function (page) {
    var servers = extractPelisHaxServers(page.text);
    var streamwishSources = servers.filter(function (item) { return item.provider === 'streamwish'; });
    var vidhideSources = ENABLE_VIDHIDE
      ? servers.filter(function (item) { return item.provider === 'vidhide'; })
      : [];

    log('PelisHaxPro: ' + servers.length + ' servidor(es) en español latino; StreamWish: ' + streamwishSources.length + '; VidHide: ' + (ENABLE_VIDHIDE ? vidhideSources.length : 'desactivado por switch'));
    streamwishSources.forEach(function (item) { log('Fuente asignada a decoder StreamWish: ' + safeUrl(item.url)); });
    vidhideSources.forEach(function (item) { log('Fuente asignada a decoder VidHide: ' + safeUrl(item.url)); });
    if (!servers.length) {
      log('No se encontraron servidores compatibles en español latino. Se omiten castellano y otros idiomas.');
      return [];
    }

    // Ambos decoders se ejecutan en paralelo; el catálogo final conserva StreamWish
    // primero y VidHide después, igual que el proveedor de referencia.
    return Promise.all([
      resolveStreamwishSources(streamwishSources, 'LAT', type),
      ENABLE_VIDHIDE ? resolveVidHideSources(vidhideSources, 'LAT', type) : Promise.resolve([])
    ]).then(function (results) {
      var streamwishStreams = results[0] || [];
      var vidhideStreams = results[1] || [];
      var streams = combineProviderStreams(streamwishStreams, vidhideStreams);
      log('Resultado: ' + streams.length + ' playlist(s) HLS; StreamWish: ' + streamwishStreams.length + '; VidHide: ' + (ENABLE_VIDHIDE ? vidhideStreams.length : 'desactivado'));
      return streams;
    });
  }).catch(function (error) {
    console.error('[PelisHaxPro] ' + (error && error.message ? error.message : String(error)));
    return [];
  });
}

module.exports = { getStreams: getStreams };

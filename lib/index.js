'use strict';

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const async = require('async');
const cheerio = require('cheerio');
const deepmerge = require('deepmerge');
const minimatch = require('minimatch');
const userAgents = require('top-user-agents');

/**
 * Flip an object of arrays so the array values become the keys.
 * @template K,V
 * @param {Object.<K, Array.<V>>} input
 * @returns {Object.<V, Array.<K>>}
 */
const flipObjectOfArrays = (input) => {
  const output = {};
  Object.keys(input)
    .forEach((key) => {
      input[key]
        .forEach((val) => {
          if (output[val] === undefined) {
            output[val] = [];
          }
          output[val].push(key);
        });
    });
  return output;
};

/**
 * Return a fake user agent.
 * @returns {string}
 */
const userAgent = () => userAgents[0];

/**
 * A lenient WHATWG version of url.parse().
 * @param {String} input
 * @returns {{}|URL}
 */
const urlParse = (input) => {
  try {
    return new URL(input);
  } catch (err) {
    return {};
  }
}

/**
 * Gather all links from all HTML files.
 * @param {Object} files
 * @param {Object} options
 * @returns {Object}
 */
const htmlLinks = (files, options) => Object.keys(files)
  // For each HTML file that matches the given pattern
  .filter(minimatch.filter(options.html.pattern))
  .reduce((obj, filename) => {
    const file = files[filename];
    const $ = cheerio.load(file.contents);

    const normalizedFilename = filename.replace(/[/\\]/g, '/');
    obj[normalizedFilename] = [].concat(
      // For each given tag
      ...Object.keys(options.html.tags)
        .map((tag) => {
          let attributes = options.html.tags[tag];
          if (!Array.isArray(attributes)) {
            attributes = [attributes];
          }

          return [].concat(
            // For each given attribute, get the value of it
            ...attributes.map((attribute) => $(`${tag}[${attribute}][${attribute}!='']`)
              .map((i, elem) => $(elem).attr(attribute))
              .get()),
          );
        }),
    );
    return obj;
  }, {});

/**
 * @typedef {function} validator
 * @param {string} link
 * @param {Object} options Plugin options
 * @param {validatorCallback} asyncCallback
 */

/**
 * @callback validatorCallback
 * @param {Object} err
 * @param {?string} validationError
 */

/**
 * Call a callback with if `link` is a valid URL or not.
 * @type {validator}
 */
const validUrl = (link, options, asyncCallback, method = 'HEAD') => {
  const library = (link.substr(0, 5) === 'https' ? https : http);
  library.request(link, {
    method,
    headers: {
      // TODO: something to fix Pixabay
      'User-Agent': options.userAgent,
    },
    timeout: options.timeout,
    rejectUnauthorized: false,
  }, (res) => {
    // Re-attempt HEAD 405s as GETs
    if (res.statusCode === 405 && method !== 'GET') {
      validUrl(link, options, asyncCallback, 'GET');
      return;
    }

    // TODO: retry mechanism
    if (!res) {
      asyncCallback(null, 'no response');
    } else if (res.statusCode >= 400 && res.statusCode <= 599) {
      asyncCallback(null, `HTTP ${res.statusCode}`);
    } else {
      asyncCallback(null, null);
    }
  }).on('error', (err) => {
    asyncCallback(null, err.message);
  }).end();
};

/**
 * Return if a `dest` link from a `src` file is valid or not.
 * @param {Object} files
 * @param {string} src
 * @param {string} dest
 * @returns {boolean}
 */
const validLocal = (files, src, dest) => {
  // TODO: anchor validation
  // Strip trailing anchor link
  dest = dest.replace(/#[^/\\]*$/, '');

  // Reference to self is always valid
  if (dest === '' || dest === '.' || dest === './') {
    return true;
  }

  const linkPath = path.join(path.dirname(src), dest);
  // Reference to self is always valid
  if (linkPath === '' || linkPath === '.' || linkPath === './') {
    return true;
  }

  return linkPath in files || path.join(linkPath, 'index.html') in files;
};

/**
 * @type {Object.<string, validator>}
 */
const protocolValidators = {
  'http:': validUrl,
  'https:': validUrl,
  // TODO: mailto: validation
  // TODO: tel: validation
  // TODO: sms: validation
};

/**
 * Plugin entrypoint.
 * @param {Object} options
 * @returns {function(Object.<string, Object>, Object, function)}
 */
module.exports = (options) => {
  options = deepmerge({
    html: {
      pattern: '**/*.html',
      tags: {
        a: 'href',
        img: ['src', 'data-src'],
        link: 'href',
        script: 'src',
      },
    },
    ignore: [],
    timeout: 15 * 1000,
    userAgent: userAgent(),
    parallelism: os.cpus().length * 4,
  }, options || {});

  return (files, metalsmith, done) => {
    const normalizedFilenames = Object.keys(files)
      .reduce((reducer, filename) => {
        reducer[filename.replace(/[/\\]/g, '/')] = true;
        return reducer;
      }, {});

    // Gather the links contained in all files, and then invert the array to reduce items to check
    const filenamesToLinks = {
      ...htmlLinks(files, options),
      // TODO: CSS files
      // TODO: manifest files
    };
    const linksToFilenames = flipObjectOfArrays(filenamesToLinks);

    // Process ignored links
    options.ignore = options.ignore.map((pattern) => new RegExp(pattern));
    Object.keys(linksToFilenames)
      .filter((link) => options.ignore.some((re) => re.test(link)))
      .forEach((link) => delete linksToFilenames[link]);

    // For each link, find the files it is broken for
    async.mapValuesLimit(linksToFilenames, options.parallelism, (filenames, link, callback) => {
      // Validate links with a protocol (remote links)
      const linkUrl = urlParse(link);
      if (linkUrl.protocol) {
        if (protocolValidators[linkUrl.protocol] !== undefined) {
          const valid = protocolValidators[linkUrl.protocol](link, options, callback);
          if (valid === undefined) {
            // Validation function didn't return anything, it will call the callback for us
            return;
          }
          // Otherwise, call the callback with the validation result
          callback(null, valid ? null : 'not found');
          return;
        }

        // Assume all unknown protocols are valid
        callback(null, null);
        return;
      }

      // Validate local files
      const badFilenames = filenames
        .filter((filename) => !validLocal(normalizedFilenames, filename, link));
      callback(null, badFilenames.length === 0 ? null : 'not found');
    }, (err, result) => {
      if (err) {
        done(err);
        return;
      }

      const filenamesToLinkErrors = Object.keys(filenamesToLinks)
        .reduce((obj, filename) => {
          const linkErrors = filenamesToLinks[filename]
            .filter((link) => result[link])
            .map((link) => `${link} (${result[link]})`);
          if (linkErrors.length) {
            obj[filename] = linkErrors;
          }
          return obj;
        }, {});

      // Return a pretty formatted error if there are bad links
      if (Object.keys(filenamesToLinkErrors).length) {
        const message = Object.keys(filenamesToLinkErrors).sort()
          .map((filename) => {
            const output = filenamesToLinkErrors[filename].sort()
              .map((link) => `  ${link}`)
              .join('\n');
            return `${filename}:\n${output}`;
          })
          .join('\n\n');
        done(`Broken links found:\n\n${message}`);
      }

      done();
    });
  };
};

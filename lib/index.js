'use strict';

const https = require('https');
const os = require('os');
const path = require('path');
const url = require('url');

const async = require('async');
const cheerio = require('cheerio');
const deepmerge = require('deepmerge');
const minimatch = require('minimatch');
const userAgents = require('top-user-agents');

/**
 * Return a fake user agent.
 * @returns {string}
 */
const userAgent = () => userAgents[0];

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
 * Call a callback with if `link` is a valid URL or not.
 * @param {string} link
 * @param {Object} options Plugin options
 * @param {function} filterCallback
 */
const validUrl = (link, options, filterCallback) => {
  https.request(link, {
    method: 'HEAD',
    headers: {
      'User-Agent': options.userAgent,
    },
    timeout: options.timeout,
  }, (res) => {
    const httpError = res.statusCode >= 400 && res.statusCode <= 599;
    filterCallback(null, httpError);
  }).on('error', (err) => {
    filterCallback(err, true);
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
  dest = dest.replace(/#[^/\\]+$/, '');

  if (dest === '.' || dest === './') {
    return true;
  }

  const linkPath = path.join(path.dirname(src), dest);
  if (linkPath === '.' || linkPath === './') {
    return true;
  }

  const normalizedFilenames = Object.keys(files)
    // Map to a consistent path separator
    .map((resource) => resource.replace(/[/\\]/g, '/'));
  return normalizedFilenames.indexOf(linkPath) !== -1
    || normalizedFilenames.indexOf(`${linkPath}/index.html`) !== -1;
};

/**
 * Plugin entrypoint.
 * @param {Object} options
 * @returns {function}
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
    timeout: 15,
    userAgent: userAgent(),
    parallelism: os.cpus().length * 4,
  }, options || {});

  return (files, metalsmith, done) => {
    const links = {
      ...htmlLinks(files, options),
    };

    // For each input file
    async.reduce(Object.keys(links), {}, (fileResults, filename, fileCallback) => {
      // Check each link
      async.filterLimit(links[filename], options.parallelism, (link, linkCallback) => {
        const linkUrl = url.parse(link);
        if (linkUrl.protocol) {
          if (linkUrl.protocol.match(/^https?:$/)) {
            // Validate real URLs
            validUrl(link, options, linkCallback);
            return;
          }
          // TODO: mailto: validation
          // TODO: tel: validation
          // TODO: sms: validation
          linkCallback(null, false);
          return;
        }

        // Validate local files
        linkCallback(null, !validLocal(files, filename, link));
      }, (err, results) => {
        if (err) {
          fileCallback(err, fileResults);
        }
        if (results.length) {
          fileResults[filename] = results;
        }
        fileCallback(null, fileResults);
      });
    }, (err, results) => {
      if (err) {
        done(err);
      }

      if (Object.keys(results).length) {
        // TODO: a different error message
        done(`Broken links found:\n\n${JSON.stringify(results, null, 2)}`);
      }

      done();
    });
  };
};

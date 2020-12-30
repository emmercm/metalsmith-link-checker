'use strict';

const http = require('http');
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
 * @param {string} method
 */
const validUrl = (link, options, filterCallback, method = 'HEAD') => {
  const library = (link.substr(0, 5) === 'https' ? https : http);
  library.request(link, {
    method,
    headers: {
      // TODO: something to fix Pixabay
      'User-Agent': options.userAgent,
    },
    timeout: options.timeout,
  }, (res) => {
    // Re-attempt HEAD 405s as GETs
    if (res.statusCode === 405 && method !== 'GET') {
      validUrl(link, options, filterCallback, 'GET');
      return;
    }

    const httpError = res.statusCode >= 400 && res.statusCode <= 599;
    filterCallback(null, httpError);
  }).on('error', () => {
    filterCallback(null, true);
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
  dest = dest.replace(/#[^/\\]+$/, '');

  // Reference to self is always valid
  if (dest === '' || dest === '.' || dest === './') {
    return true;
  }

  const linkPath = path.join(path.dirname(src), dest);
  // Reference to self is always valid
  if (linkPath === '' || linkPath === '.' || linkPath === './') {
    return true;
  }

  // Map to a consistent path separator
  const normalizedFilenames = Object.keys(files)
    .map((resource) => resource.replace(/[/\\]/g, '/'));

  // Link is valid if it's in the input files
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
    // TODO: ignore regex/strings
    timeout: 15,
    userAgent: userAgent(),
    parallelism: os.cpus().length * 4,
  }, options || {});

  return (files, metalsmith, done) => {
    const links = {
      ...htmlLinks(files, options),
      // TODO: CSS files
      // TODO: manifest files
    };

    // For each input file, find its broken links
    async.reduce(Object.keys(links), {}, (fileResults, filename, fileCallback) => {
      // For each link within a file, check if its broken
      async.filterLimit(links[filename], options.parallelism, (link, linkCallback) => {
        // Validate links with a protocol
        const linkUrl = url.parse(link);
        if (linkUrl.protocol) {
          if (linkUrl.protocol.match(/^https?:$/)) {
            // Validate HTTP URLs
            validUrl(link, options, linkCallback);
            return;
          }

          // TODO: mailto: validation
          // TODO: tel: validation
          // TODO: sms: validation
          // Assume all other protocols are valid
          linkCallback(null, false);
          return;
        }

        // Validate local files
        linkCallback(null, !validLocal(files, filename, link));
      }, (err, results) => {
        // Collect the broken link results, keyed by source filename
        if (err) {
          fileCallback(err, fileResults);
          return;
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
        const message = Object.keys(results).sort()
          .map((filename) => {
            const output = results[filename].sort()
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

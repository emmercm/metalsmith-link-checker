'use strict';

const os = require('os');
const path = require('path');
const url = require('url');

const async = require('async');
const cheerio = require('cheerio');
const deepmerge = require('deepmerge');
const minimatch = require('minimatch');
const request = require('sync-request');
const userAgents = require('top-user-agents');

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
 * @param {string} method
 */
const validUrl = (link, options, method = 'HEAD') => {
  let res;
  try {
    res = request(method, link, {
      headers: {
        // TODO: something to fix Pixabay
        'User-Agent': options.userAgent,
      },
      timeout: options.timeout,
      retry: true,
      maxRetries: 3,
    });
  } catch (e) {
    res = null;
  }

  if ((!res || res.statusCode === 405) && method !== 'GET') {
    return validUrl(link, options, 'GET');
  }

  return res && !(res.statusCode >= 400 && res.statusCode <= 599);
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

  // Map to a consistent path separator
  const normalizedFilenames = Object.keys(files)
    .map((resource) => resource.replace(/[/\\]/g, '/'));

  // Link is valid if it's in the input files
  return normalizedFilenames.indexOf(linkPath) !== -1
    || normalizedFilenames.indexOf(`${linkPath}/index.html`) !== -1;
};

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
    timeout: 15 * 1000,
    userAgent: userAgent(),
    parallelism: os.cpus().length * 4,
  }, options || {});

  return (files, metalsmith, done) => {
    // Gather the links contained in all files, and then invert the array to reduce items to check
    const filenamesToLinks = {
      ...htmlLinks(files, options),
      // TODO: CSS files
      // TODO: manifest files
    };
    const linksToFilenames = flipObjectOfArrays(filenamesToLinks);

    // For each link, find the files it is broken for
    async.mapValuesLimit(linksToFilenames, options.parallelism, (filenames, link, callback) => {
      // Validate links with a protocol
      const linkUrl = url.parse(link);
      if (linkUrl.protocol) {
        if (protocolValidators[linkUrl.protocol] !== undefined) {
          const badFilenames = protocolValidators[linkUrl.protocol](link, options) ? [] : filenames;
          callback(null, badFilenames);
          return;
        }

        // Assume all unknown protocols are valid
        callback(null, []);
        return;
      }

      // Validate local files
      const badFilenames = filenames.filter((filename) => !validLocal(files, filename, link));
      callback(null, badFilenames);
    }, (err, result) => {
      if (err) {
        done(err);
        return;
      }

      // Return a pretty formatted error if there are bad links
      result = flipObjectOfArrays(result);
      if (Object.keys(result).length) {
        const message = Object.keys(result).sort()
          .map((filename) => {
            const output = result[filename].sort()
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

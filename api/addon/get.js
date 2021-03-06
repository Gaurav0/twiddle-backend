/*jshint node:true */
var config = require('./config');

var AWS = require('aws-sdk');
var https = require('https');
var s3 = new AWS.S3();
var lambda = new AWS.Lambda();


exports.handler = function getAddon(event, context) {

  console.log('Running in env: ' + config.env);

  var addon = event.addon;
  var addonVersion = event.addon_version;
  var emberVersion = event.ember_version;

  resolvePackage(addon, addonVersion, emberVersion)
    .catch(packageNotFound.bind(undefined, context))
    .then(s3LookupAddon.bind(undefined, context))
    .then(createAddonJSON.bind(undefined, context))
    .then(scheduleAddonBuild.bind(undefined, context))
    .catch(function(err) {
      context.fail('An unknown error occurred: ' + err);
    })
    .then(redirectToAddon.bind(undefined, context));
};

/**
 * Returns a Promise that resolves if the package could
 * be resolved in NPM and fails if it could not
 * @param  {[type]} addon        [description]
 * @param  {[type]} addonVersion [description]
 * @return {[type]}              [description]
 */
function resolvePackage(addon, addonVersion, emberVersion) {
  return new Promise(function(resolve, reject) {
    console.log('Resolving addon in NPM');

    emberVersion = resolveBuilderEmberVersion(emberVersion);

    return https.get({
      host: 'registry.npmjs.com',
      path: '/' + addon + '/' + addonVersion
    }, function(response) {
      var body = '';
      response.on('data', function(d) {
        body += d;
      });
      response.on('end', function() {
        var npmData;
        try {
          npmData = JSON.parse(body);
        } catch(error) {
          reject(`Failed to parse json from registry.npmjs.com/${addon}/${addonVersion}: Error: ${error}`);
        }
        var npmData = JSON.parse(body);
        if (isValidAddon(npmData)) {
          resolve({
            name: addon,
            version: npmData.version,
            emberVersion: emberVersion,
            isAlreadyBuilt: null,
            isValidAddon: true});
        }
        else {
          reject(Error('Not valid addon: ' + JSON.stringify(npmData)));
        }
      });
      response.on('error', function(err) {
        reject(error);
      });
    });
  });
}

/**
 * Checks whether an NPM package is a valid addon.
 * @param  {[type]}  npmData [description]
 * @return {Boolean}         [description]
 */
function isValidAddon(npmData) {
  if(npmData.version) {
    if(npmData.keywords) {
      return (npmData.keywords.indexOf('ember-addon')!==-1);
    }
  }
}

/**
 * Resolves ember version for the builder, raises if not found
 * @param  {[type]} emberVersion [description]
 * @return {[type]}              [description]
 */
function resolveBuilderEmberVersion(emberVersion) {
  for (var builderVersion in config.builderEmberVersions) {
    var builderVersionSupportRe = config.builderEmberVersions[builderVersion];
    if(emberVersion.match(builderVersionSupportRe)) {
      return builderVersion;
    }
  }

  throw Error('No support for ember version "' + emberVersion + '".\n' +
              'Supported versions: "' + Object.keys(config.builderEmberVersions).join('", "') + '"');
}

/**
 * Redirect to the addon in S3
 * @param  {[type]} context      [description]
 * @param  {[type]} emberVersion [description]
 * @param  {[type]} addon        [description]
 * @param  {[type]} addonVersion [description]
 * @return {[type]}              [description]
 */
function redirectToAddon(context, addon) {
  var addonS3Url = 'https://' + config.addonBucketName + '/ember-' + addon.emberVersion + '/' + addon.name + '/' + addon.version + '/addon.json';
  context.done(null, { 'location': addonS3Url });
}

/**
 * Return a not found error
 * @param  {[type]} context     [description]
 * @param  {[type]} packageData [description]
 * @return {[type]}             [description]
 */
function packageNotFound(context, npmError) {
  context.fail('Version or package not found or not a valid addon, error details: ' + npmError);
}

/**
 * Returns a Promise that resolves if the addon was found in
 * S3 and fails if it wasn't.
 * @param  {[type]} emberVersion [description]
 * @param  {[type]} addon        [description]
 * @param  {[type]} addonVersion [description]
 * @return {[type]}              [description]
 */
function s3LookupAddon(context, addon) {
  return new Promise(function(resolve, reject) {
    console.log('Looking up addon in S3');

    var params = {
      Bucket: config.addonBucketName,
      Key: 'ember-' + addon.emberVersion + '/' + addon.name + '/' + addon.version + '/addon.json'
    };

    s3.headObject(params, function(err) {
      addon.isAlreadyBuilt = !err;
      resolve(addon);
    });
  });
}

function scheduleAddonBuild(context, addon) {
  return new Promise(function(resolve, reject) {
    console.log('Scheduling addon build');

    if(addon.isAlreadyBuilt) {
      console.log('Addon already built');
      return resolve(addon);
    }

    var params = {
      FunctionName: config.schedulerLambdaFunctionname, /* required */
      InvocationType: 'Event',
      Payload: JSON.stringify({
        addon: addon.name,
        addon_version: addon.version,
        ember_version: addon.emberVersion,
        triggered_by: 'api'
      }),
    };
    lambda.invoke(params, function(err) {
      if(err) {
        reject(err);
      }
      resolve(addon);
    });
  });
}

function createAddonJSON(context, addon) {
  return new Promise(function(resolve, reject) {
    console.log('Registering addon in S3');

    if(addon.isAlreadyBuilt) {
      console.log('Addon already built');
      return resolve(addon);
    }

    s3.putObject({
      Bucket: config.addonBucketName,
      ACL: 'public-read',
      Key: 'ember-' + addon.emberVersion + '/' + addon.name + '/' + addon.version + '/addon.json',
      ContentType: 'application/json',
      CacheControl: 'max-age=0, no-cache',
      Body: JSON.stringify({
        status: 'building',
        status_date: new Date().toISOString(),
        addon_js: null,
        addon_css: null,
        error_log: null
      })
    }, function(err) {
      if (err) {
        return reject(err);
      }
      return resolve(addon);
    });
  });
}
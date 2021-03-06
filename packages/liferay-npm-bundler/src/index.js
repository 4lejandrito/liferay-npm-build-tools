import * as babel from 'babel-core';
import fs from 'fs-extra';
import globby from 'globby';
import {getPackageTargetDir} from 'liferay-npm-build-tools-common/lib/packages';
import path from 'path';
import pretty from 'pretty-time';
import readJsonSync from 'read-json-sync';

import * as config from './config';
import {getPackageDependencies} from './dependencies';
import * as log from './log';

/**
 * Default entry point for the liferay-npm-bundler.
 * @param {Array} args command line arguments
 * @return {void}
 */
export default function(args) {
	let promises = [];

	if (args[0] === '-v' || args[0] === '--version') {
		showVersions();
		return;
	}

	const outputDir = path.resolve(config.getOutputDir());

	// Create work directories
	fs.mkdirsSync(path.join(outputDir, 'node_modules'));

	// Copy project's package.json
	promises.push(copyRootPackageJson(outputDir));

	// Grab NPM dependencies
	let pkgs = getPackageDependencies('.');
	pkgs = Object.keys(pkgs).map(id => pkgs[id]);
	pkgs = pkgs.filter(pkg => pkg.dir != '.');

	// Process NPM dependencies
	const start = process.hrtime();

	log.info(`Bundling ${pkgs.length} dependencies...`);

	if (config.isProcessSerially()) {
		promises.push(
			iterateSerially(pkgs, pkg => bundlePackage(pkg, outputDir))
		);
	} else {
		promises.push(...pkgs.map(pkg => bundlePackage(pkg, outputDir)));
	}

	Promise.all(promises)
		.then(() => log.info(`Bundling took ${pretty(process.hrtime(start))}`))
		.catch(function(err) {
			log.error(err);
			process.exit(1);
		});
}

/**
 * Show versions information
 * @return {void}
 */
function showVersions() {
	const pkgJson = require('../package.json');

	let info = {
		'liferay-npm-bundler': pkgJson.version,
	};

	info = Object.assign(info, config.getPluginVersions());

	console.log(JSON.stringify(info, null, 2));
}

/**
 * Copy project root package.json file to output directory.
 * @param {String} outputDir the output directory path
 * @return {Promise} a Promise fulfilled when the copy has been finished
 */
function copyRootPackageJson(outputDir) {
	return fs.copy('package.json', path.join(outputDir, 'package.json'));
}

/**
 * Iterate through the elements of an array applying an async process serially
 * to each one of them.
 * @param {Array} values array of values to be iterated
 * @param {function} asyncProcess the async process (that returns a Promise) to
 *        be executed on each value
 * @return {Promise} a Promise that is resolved as soon as the iteration
 *         finishes
 */
function iterateSerially(values, asyncProcess) {
	return new Promise(resolve => {
		if (values.length == 0) {
			resolve();
			return;
		}

		let val = values[0];

		asyncProcess(val).then(() => {
			iterateSerially(values.slice(1), asyncProcess).then(() => {
				resolve();
			});
		});
	});
}

/**
 * Bundle a npm package
 * @param {Object} pkg the package descriptor hash containing id, name, version
 *        and dir fields
 * @param {String} outputDir directory where bundled packages are placed
 * @return {Promise} a promise that is fulfilled when the package is bundled
 */
function bundlePackage(pkg, outputDir) {
	const outPkgDir = path.join(
		outputDir,
		'node_modules',
		getPackageTargetDir(pkg.name, pkg.version)
	);

	try {
		if (fs.statSync(outPkgDir).isDirectory()) {
			log.debug(`Skipping ${pkg.id} (already bundled)`);
			return;
		}
	} catch (err) {}

	log.debug(`Bundling ${pkg.id}`);

	fs.mkdirsSync(outPkgDir);

	return copyPackage(pkg, outPkgDir)
		.then(() => (pkg.dir = outPkgDir))
		.then(() => processPackage('pre', pkg))
		.then(() => runBabel(pkg))
		.then(() => processPackage('post', pkg))
		.then(() => log.debug(`Bundled ${pkg.id}`));
}

/**
 * Copy an NPM package to output directory.
 * @param {Object} pkg the package descriptor hash containing id, name, version
 *        and dir fields
 * @param {String} dir the output directory path
 * @return {Promise} a Promise fulfilled when the copy has been finished
 */
function copyPackage(pkg, dir) {
	const exclusions = config.getExclusions(pkg);

	const globs = [`${pkg.dir}/**/*`, `!${pkg.dir}/node_modules/**/*`].concat(
		exclusions.map(exclusion => `!${pkg.dir}/${exclusion}`)
	);

	return globby(globs).then(paths => {
		paths = paths
			.filter(path => fs.statSync(path).isFile())
			.map(path => path.substring(pkg.dir.length + 1));

		const promises = paths.map(path =>
			fs.copy(`${pkg.dir}/${path}`, `${dir}/${path}`)
		);

		return Promise.all(promises);
	});
}

/**
 * Process an NPM package with the configured liferay-nmp-bundler plugins. This
 * function is called two times (known as phases) per package: one before Babel
 * runs and one after.
 * @param {String} phase 'pre' or 'post' depending on what phase we are in
 * @param {Object} pkg the package descriptor hash containing id, name, version
 *        and dir fields
 * @return {Promise} a Promise fulfilled when the process has been finished
 */
function processPackage(phase, pkg) {
	return new Promise((resolve, reject) => {
		const pkgJsonPath = path.join(pkg.dir, 'package.json');
		const pkgJson = readJsonSync(pkgJsonPath);

		let state = {
			pkgJson: pkgJson,
		};

		try {
			config.getPlugins(phase, pkg).forEach(plugin => {
				plugin.run({pkg, config: plugin.config}, state);
			});
		} catch (err) {
			reject(err);
		}

		fs.writeFileSync(pkgJsonPath, JSON.stringify(state.pkgJson, '', 2));

		resolve();
	});
}

/**
 * Run Babel on a package.
 * @param {Object} pkg the package descriptor hash containing id, name, version
 *        and dir fields
 * @return {Promise} a Promise fulfilled when the process has been finished
 */
function runBabel(pkg) {
	const babelConfig = config.getBabelConfig(pkg);

	// Intercept presets and plugins to load them from here
	babelConfig.plugins = config.loadBabelPlugins(
		babelConfig.presets || [],
		babelConfig.plugins || []
	);
	babelConfig.presets = [];

	// Tune babel config
	babelConfig.babelrc = false;
	babelConfig.only = '**/*';
	if (babelConfig.sourceMaps === undefined) {
		babelConfig.sourceMaps = true;
	}

	// Run babel through it
	return globby([`${pkg.dir}/**/*.js`]).then(filePaths => {
		const promises = filePaths.map(
			filePath =>
				new Promise((resolve, reject) => {
					babel.transformFile(
						filePath,
						Object.assign(
							{
								filenameRelative: filePath,
							},
							babelConfig
						),
						(err, result) => {
							if (err) {
								log.error(`Error processing file: ${filePath}`);
								reject(err);
							} else {
								const fileName = path.basename(filePath);

								fs.writeFileSync(
									filePath,
									`${result.code}\n` +
										`//# sourceMappingURL=${fileName}.map`
								);

								fs.writeFileSync(
									`${filePath}.map`,
									JSON.stringify(result.map)
								);

								resolve();
							}
						}
					);
				})
		);

		return Promise.all(promises);
	});
}

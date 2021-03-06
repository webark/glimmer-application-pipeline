'use strict';
const ConfigLoader = require('broccoli-config-loader');
const ConfigReplace = require('broccoli-config-replace');
const Funnel = require('broccoli-funnel');
const concat = require('broccoli-concat');
const path  = require('path');
const fs = require('fs');
const typescript = require('broccoli-typescript-compiler').typescript;
const existsSync = require('exists-sync');
const MergeTrees = require('broccoli-merge-trees');
const compileSass = require('broccoli-sass');
const assetRev = require('broccoli-asset-rev');
const uglify = require('broccoli-uglify-sourcemap');
const ResolutionMapBuilder = require('@glimmer/resolution-map-builder');
const ResolverConfigurationBuilder = require('@glimmer/resolver-configuration-builder');
const BroccoliSource = require('broccoli-source');
const WatchedDir = BroccoliSource.WatchedDir;
const UnwatchedDir = BroccoliSource.UnwatchedDir;
const SilentError = require('silent-error');
const p = require('ember-cli-preprocess-registry/preprocessors');
const stripIndent = require('common-tags').stripIndent;
const utils = require('ember-build-utilities');
const addonProcessTree = utils.addonProcessTree;
const GlimmerTemplatePrecompiler = utils.GlimmerTemplatePrecompiler;
const resolveLocal = utils.resolveLocal;
const setupRegistry = p.setupRegistry;
const defaultRegistry = p.defaultRegistry;
const preprocessJs = p.preprocessJs;

import RollupWithDependencies from './rollup-with-dependencies';
import defaultModuleConfiguration from './default-module-configuration';


export interface AbstractBuild {
  _notifyAddonIncluded(): void;
  package(jsTree: Tree, cssTree: Tree, publicTree: Tree, htmlTree: Tree): Tree;
}

export const AbstractBuild: { new(defaults: EmberCLIDefaults, options: {}): AbstractBuild } = utils.AbstractBuild;

function maybeDebug(inputTree: Tree, name: string) {
  if (!process.env.GLIMMER_BUILD_DEBUG) {
    return inputTree;
  }

  const debug = require('broccoli-stew').debug;

  // preserve `null` trees
  if (!inputTree) {
    return inputTree;
  }

  return debug(inputTree, { name });
}

const DEFAULT_TS_OPTIONS = {
  tsconfig: {
    compilerOptions: {
      target: "es5",
      module: "es2015",
      inlineSourceMap: true,
      inlineSources: true,
      moduleResolution: "node"
    },
    exclude: [
      'node_modules',
      '**/*.d.ts'
    ]
  }
};

export interface AbstractBuild {
  _notifyAddonIncluded(): void;
  package(jsTree: Tree, cssTree: Tree, publicTree: Tree, htmlTree: Tree): Tree;
}

export interface Registry {
  add(type: string, plugin: Function)
}

export interface OutputPaths {
  app: {
    html: string;
    js: string;
    css: string;
  }
}
export interface EmberCLIDefaults {
  project: Project
}

// documented rollup options from
// https://github.com/rollup/rollup/wiki/JavaScript-API#rolluprollup-options-
export interface RollupOptions {
  plugins?: any[],
  treeshake?: boolean,
  external?: string[] | ((id: string) => boolean);
  paths?: { [importId: string]: string } | ((id: string) => string);
}

export interface GlimmerAppOptions {
  outputPaths?: {
    app?: {
      html?: string;
      js?: string;
      css?: string;
    }
  }
  trees?: {
    src?: Tree | string;
    nodeModules?: Tree | string;
  }
  registry?: Registry;
  rollup?: RollupOptions;
}

export interface Addon {
  contentFor: (type: string, config, content: string[]) => string;
  preprocessTree: (type: string, tree: Tree) => Tree;
  included: (GlimmerApp) => void;
}

export interface Project {
  root: string;
  name(): string;
  configPath(): string;
  addons: Addon[];

  findAddonByName(name: string): Addon | null;

  pkg: {
    name: string;
  }

  ui: {
    writeLine(contents: string);
    writeWarnLine(contents: string);
  }
}

export interface Trees {
  src: Tree;
  nodeModules: Tree;
}

export interface Tree {

}

/**
 * GlimmerApp provides an interface to a package (app, engine, or addon)
 * compatible with the module unification layout.
 *
 * @class GlimmerApp
 * @constructor
 * @param {Object} [defaults]
 * @param {Object} [options=Options] Configuration options
 */
export default class GlimmerApp extends AbstractBuild {
  public project: Project;
  public name: string;
  public env: 'production' | 'development' | 'test';
  private registry: Registry;
  private outputPaths: OutputPaths;
  private rollupOptions: RollupOptions;
  protected options;

  protected trees: Trees;

  constructor(upstreamDefaults: EmberCLIDefaults, options: GlimmerAppOptions = {}) {
    let missingProjectMessage = 'You must pass through the default arguments passed into your ember-cli-build.js file when constructing a new GlimmerApp';
    if (arguments.length === 0) {
      throw new Error(missingProjectMessage);
    }

    if (!upstreamDefaults.project) {
      throw new Error(missingProjectMessage);
    }

    let isProduction = process.env.EMBER_ENV === 'production';

    let defaults = Object.assign({}, upstreamDefaults, {
      addons: {
        whitelist: null as string[] | null,
        blacklist: null as string[] | null,
      },
      outputPaths: {
        app: {
          html: 'index.html',
          js: 'app.js',
          css: 'app.css'
        }
      },
      rollup: { },
      minifyJS: {
        enabled: isProduction,
      },
      sourcemaps: {
        enabled: !isProduction
      }
    });

    super(defaults, options);

    this.registry = options.registry || defaultRegistry(this);

    this.env = process.env.EMBER_ENV || 'development';
    this.name = this.project.name();

    this.rollupOptions = options.rollup;

    setupRegistry(this);

    this.trees = this.buildTrees(options);
    this.outputPaths = options.outputPaths as OutputPaths;
    this.detectInvalidBlueprint(options);

    this['_notifyAddonIncluded']();
  }

  public import() {
    throw new Error('app.import is not yet implemented for GlimmerApp');
  }

  private _configReplacePatterns() {
    return [{
      match: /\{\{rootURL\}\}/g,
      replacement: (config) => config.rootURL || '',
    }, {
      match: /\{\{content-for ['"](.+)["']\}\}/g,
      replacement: this.contentFor.bind(this)
    }];
  }

  private buildTrees(options: GlimmerAppOptions): Trees {
    let srcTree = options.trees && options.trees.src;
    let { project: { root } } = this;

    if (typeof srcTree === 'string') {
      srcTree = new WatchedDir(resolveLocal(root, srcTree));
    } else if (!srcTree) {
      let srcPath = resolveLocal(root, 'src');
      srcTree = existsSync(srcPath) ? new WatchedDir(srcPath) : null;
    }

    if (srcTree) {
      srcTree = new Funnel(srcTree, {
        destDir: 'src'
      });

      srcTree = addonProcessTree(this.project, 'preprocessTree', 'src', srcTree);
    }

    let nodeModulesTree = options.trees && options.trees.nodeModules || new UnwatchedDir(resolveLocal(root, 'node_modules'));

    if (nodeModulesTree) {
      nodeModulesTree = new Funnel(nodeModulesTree, {
        destDir: 'node_modules/'
      });
    }

    return {
      src: maybeDebug(srcTree, 'src'),
      nodeModules: nodeModulesTree
    }
  }

  private tsOptions() {
    let tsconfigPath = resolveLocal(this.project.root, 'tsconfig.json');
    let tsconfig;

    if (existsSync(tsconfigPath)) {
      try {
        tsconfig = require(tsconfigPath);
      } catch (err) {
        console.log("Error reading from tsconfig.json");
      }
    } else {
      console.log("No tsconfig.json found; falling back to default TypeScript settings.");
    }

    return tsconfig ? { tsconfig } : DEFAULT_TS_OPTIONS;
  }

  private javascript() {
    let { src, nodeModules } = this.trees;
    let tsConfig = this.tsOptions();
    let configTree = this.buildConfigTree(src);
    let srcWithoutHBSTree = new Funnel(src, {
      exclude: ['**/*.hbs', '**/*.ts']
    });

    // Compile the TypeScript and Handlebars files into JavaScript
    let compiledHandlebarsTree = this.compiledHandlebarsTree(src);
    let combinedConfigAndCompiledHandlebarsTree = new MergeTrees([configTree, compiledHandlebarsTree]);

    // the output tree from typescript only includes the output from .ts -> .js transpilation
    // and no other files from the original source tree
    let transpiledTypescriptTree = this.compiledTypeScriptTree(combinedConfigAndCompiledHandlebarsTree, nodeModules, tsConfig);

    // Merge the JavaScript source and generated module map and resolver
    // configuration files together, making sure to overwrite the stub
    // module-map.js and resolver-configuration.js in the source tree with the
    // generated ones.
    transpiledTypescriptTree = new MergeTrees([srcWithoutHBSTree, transpiledTypescriptTree, configTree], { overwrite: true });

    return this.processESLastest(transpiledTypescriptTree);
  }

  private processESLastest(tree: Tree): Tree {
    return preprocessJs(tree, '/', this.name, {
      registry: this.registry
    });
  }

  public package(jsTree, cssTree, publicTree, htmlTree): Tree {
    let missingPackages = [];
    jsTree = this.rollupTree(jsTree);
    let trees = [jsTree, htmlTree];
    if (cssTree) {
      trees.push(cssTree);
    }
    if (publicTree) {
      trees.push(publicTree);
    }

    let appTree = new MergeTrees(trees);

    appTree = this.maybePerformDeprecatedUglify(appTree, missingPackages);
    appTree = this.maybePerformDeprecatedAssetRev(appTree, missingPackages);

    if (missingPackages.length > 0) {
      this.project.ui.writeWarnLine(
`This project is relying on behaviors provided by @glimmer/application-pipeline that will be removed in future versions. The underlying functionality has now been migrated to be performed by addons in your project.

Please run the following to resolve this warning:

  ${missingPackages.join('\n  ')}`);
    }

    appTree = addonProcessTree(this.project, 'postprocessTree', 'all', appTree);
    return appTree;
  }

  /**
   * Creates a Broccoli tree representing the compiled Glimmer application.
   *
   * @param options
   */
  public toTree() {
    let jsTree = this.javascript();
    let cssTree = this.cssTree();
    let publicTree = this.publicTree();
    let htmlTree = this.htmlTree();

    return this.package(jsTree, cssTree, publicTree, htmlTree);
  }

  private compiledTypeScriptTree(srcTree: Tree, nodeModulesTree: Tree, tsConfig: {}): Tree {
    let inputTrees = new MergeTrees([nodeModulesTree, srcTree]);

    let compiledTypeScriptTree = typescript(inputTrees, tsConfig);

    return maybeDebug(compiledTypeScriptTree, 'typescript-output');
  }

  private compiledHandlebarsTree(srcTree) {
    let compiledHandlebarsTree = new GlimmerTemplatePrecompiler(srcTree, {
      rootName: this.project.pkg.name
    });

    return maybeDebug(compiledHandlebarsTree, 'handlebars-output');
  }

  private rollupTree(jsTree) {
    let rollupOptions = Object.assign({}, this.rollupOptions, {
      format: 'umd',
      entry: 'src/index.js',
      dest: this.outputPaths.app.js,
      sourceMap: this.options.sourcemaps.enabled
    });

    return new RollupWithDependencies(maybeDebug(jsTree, 'rollup-input-tree'), {
      inputFiles: ['**/*.js'],
      rollup: rollupOptions
    });
  }

  private buildConfigTree(postTranspiledSrc) {
    // Build the file that maps individual modules onto the resolver's specifier
    // keys.
    const moduleMap = this.buildResolutionMap(postTranspiledSrc);

    // Build the resolver configuration file.
    const resolverConfiguration = this.buildResolverConfiguration();

    const configTree = this._configTree();

    return new MergeTrees([moduleMap, resolverConfiguration, configTree]);
  }

  private buildResolutionMap(src) {
    return new ResolutionMapBuilder(src, this._configTree(), {
      baseDir: 'src',
      configPath: this._configPath(),
      defaultModulePrefix: this.name,
      defaultModuleConfiguration
    });
  }

  private buildResolverConfiguration() {
    return new ResolverConfigurationBuilder(this._configTree(), {
      configPath: this._configPath(),
      defaultModulePrefix: this.name,
      defaultModuleConfiguration
    });
  }

  private cssTree() {
    // should really make SASS support to be opt-in, so that
    // we can properly honor the `GlimmerAppOptions.trees.src`
    // abstraction here, but for now we still require `src` to be a
    // "real" path on disk that we check
    let stylesPath = path.join(resolveLocal(this.project.root, 'src'), 'ui', 'styles');

    if (fs.existsSync(stylesPath)) {
      // Compile SASS if app.scss is present
      // (this works with imports from app.scss)
      let scssPath = path.join(stylesPath, 'app.scss');
      if (fs.existsSync(scssPath)) {
        return compileSass([stylesPath], 'app.scss', this.outputPaths.app.css, {
          annotation: 'Funnel: scss'
        });
      }

      // Otherwise concat all the css in the styles dir
      return concat(new Funnel(stylesPath, {
        include: ['**/*.css'],
        annotation: 'Funnel: css'}),
        { outputFile: this.outputPaths.app.css });
    }
  }

  private publicTree() {
    let publicPath = 'public';

    if (fs.existsSync(publicPath)) {
      return new Funnel(publicPath, {
        annotation: 'Funnel: public'
      });
    }
  }

  public htmlTree() {
    let srcTree = this.trees.src;

    const htmlName = this.outputPaths.app.html;
    const files = [
      'src/ui/index.html'
    ];

    const index = new Funnel(srcTree, {
      files,
      getDestinationPath(relativePath) {
        if (relativePath === 'src/ui/index.html') {
          relativePath = htmlName;
        }
        return relativePath;
      },
      annotation: 'Funnel: index.html'
    });

    return new ConfigReplace(index, this._configTree(), {
      configPath: this._configPath(),
      files: [ htmlName ],
      patterns: this._configReplacePatterns()
    });
  }

  private contentFor(config, match: RegExp, type: string) {
    let content: string[] = [];

    switch (type) {
      case 'head':
        this._contentForHead(content, config);
        break;
    }

    content = <string[]>this.project.addons.reduce(function(content: string[], addon: Addon): string[] {
      var addonContent = addon.contentFor ? addon.contentFor(type, config, content) : null;
      if (addonContent) {
        return content.concat(addonContent);
      }

      return content;
    }, content);

    return content.join('\n');
  }

  protected _contentForHead(content: string[], config) {
    // TODO?
    // content.push(calculateBaseTag(config));

    // TODO?
    // if (this.options.storeConfigInMeta) {
    //   content.push('<meta name="' + config.modulePrefix + '/config/environment" ' +
    //               'content="' + escape(JSON.stringify(config)) + '" />');
    // }
  }

  protected _configPath(): string {
    return path.join('config', 'environments', this.env + '.json');
  }

  _cachedConfigTree: any;

  protected _configTree() {
    if (this._cachedConfigTree) {
      return this._cachedConfigTree;
    }

    const configPath = this.project.configPath();
    const configTree = new ConfigLoader(path.dirname(configPath), {
      env: this.env,
      project: this.project
    });

    let namespacedConfigTree = new Funnel(configTree, {
      srcDir: '/',
      destDir: 'config',
      annotation: 'Funnel (config)'
    });

    this._cachedConfigTree = maybeDebug(namespacedConfigTree, 'config-tree');

    return this._cachedConfigTree;
  }

  private maybePerformDeprecatedUglify(appTree, missingPackagesForDeprecationMessage) {
    let isProduction = process.env.EMBER_ENV === 'production';

    // if the project does not have broccoli-asset-rev itself
    // process it with a warning/deprecation
    if (isProduction && !this.project.findAddonByName('broccoli-asset-rev')) {
      missingPackagesForDeprecationMessage.push('ember install ember-cli-uglify');

      appTree = uglify(appTree, {
        compress: {
          screw_ie8: true,
        },
        sourceMapConfig: {
          enabled: false
        }
      });
    }

    return appTree;
  }

  private maybePerformDeprecatedAssetRev(appTree, missingPackagesForDeprecationMessage) {
    let isProduction = process.env.EMBER_ENV === 'production';

    // if the project does not have broccoli-asset-rev itself
    // process it with a warning/deprecation
    if (isProduction && !this.project.findAddonByName('broccoli-asset-rev')) {
      missingPackagesForDeprecationMessage.push('ember install broccoli-asset-rev');

      // Fingerprint assets for cache busting in production.
      let extensions = ['js', 'css'];
      let replaceExtensions = ['html', 'js', 'css'];

      appTree = assetRev(appTree, {
        extensions,
        replaceExtensions
      });
    }

    return appTree;
  }

  private detectInvalidBlueprint(options) {
    let srcPath = options.trees && options.trees.src || 'src';
    let resolvedSrcPath;

    if (typeof srcPath === 'string') {
      resolvedSrcPath = resolveLocal(this.project.root, srcPath)
    }

    if (!resolvedSrcPath || !existsSync(resolvedSrcPath)) { return; } // cannot do detection
    let mainPath = path.join(resolvedSrcPath, 'main.ts');

    if (existsSync(mainPath)) {
      let mainContents = fs.readFileSync(path.join(resolvedSrcPath, 'main.ts')).toString();

      let hasModuleMapInSrc = mainContents.includes(`'./config/module-map`) || mainContents.includes(`"./config/module-map"`);
      let hasResolverConfigInSrc = mainContents.includes(`'./config/resolver-configuration`) || mainContents.includes(`"./config/resolver-configuration`);

      if (hasModuleMapInSrc || hasResolverConfigInSrc) {
        throw new SilentError(stripIndent`
          Updates to your project structure are required to run with this version of @glimmer/application-pipeline.

          Please update your project by running:

            yarn upgrade @glimmer/blueprint
            ember init -b @glimmer/blueprint
        `);
      }
    }
  }
}

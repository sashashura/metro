/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall react_native
 */

import crypto from 'crypto';
import * as path from 'path';

jest.useRealTimers();

function mockHashContents(contents) {
  return crypto.createHash('sha1').update(contents).digest('hex');
}

jest.mock('../lib/checkWatchmanCapabilities', () => ({
  __esModule: true,
  default: async () => {},
}));

jest.mock('jest-worker', () => ({
  Worker: jest.fn(worker => {
    mockWorker = jest.fn((...args) => require(worker).worker(...args));
    mockEnd = jest.fn();

    return {
      end: mockEnd,
      worker: mockWorker,
    };
  }),
}));

jest.mock('../crawlers/node');
jest.mock('../crawlers/watchman', () =>
  jest.fn(options => {
    const path = require('path');

    const {previousState, ignore, rootDir, roots, computeSha1} = options;
    const list = mockChangedFiles || mockFs;
    const removedFiles = new Map();
    const changedFiles = new Map();

    previousState.clocks = mockClocks;

    for (const file in list) {
      if (
        new RegExp(roots.join('|').replace(/\\/g, '\\\\')).test(file) &&
        !ignore(file)
      ) {
        const relativeFilePath = path.relative(rootDir, file);
        if (list[file]) {
          const hash = computeSha1 ? mockHashContents(list[file]) : null;
          changedFiles.set(relativeFilePath, ['', 32, 42, 0, [], hash, 0]);
        } else {
          const fileData = previousState.files.get(relativeFilePath);
          if (fileData) {
            removedFiles.set(relativeFilePath, fileData);
          }
        }
      }
    }

    return Promise.resolve({
      removedFiles,
      changedFiles,
      clocks: mockClocks,
    });
  }),
);

const mockWatcherConstructor = jest.fn(root => {
  const EventEmitter = require('events').EventEmitter;
  mockEmitters[root] = new EventEmitter();
  mockEmitters[root].close = jest.fn();
  setTimeout(() => mockEmitters[root].emit('ready'), 0);
  return mockEmitters[root];
});

jest.mock('../watchers/NodeWatcher', () => mockWatcherConstructor);
jest.mock('../watchers/WatchmanWatcher', () => mockWatcherConstructor);

let mockChangedFiles;
let mockFs;

jest.mock('graceful-fs', () => ({
  existsSync: jest.fn(path => {
    // A file change can be triggered by writing into the
    // mockChangedFiles object.
    if (mockChangedFiles && path in mockChangedFiles) {
      return true;
    }

    if (mockFs[path]) {
      return true;
    }

    return false;
  }),
  readFileSync: jest.fn((path, options) => {
    // A file change can be triggered by writing into the
    // mockChangedFiles object.
    if (mockChangedFiles && path in mockChangedFiles) {
      return mockChangedFiles[path];
    }

    if (mockFs[path]) {
      return mockFs[path];
    }

    const error = new Error(`Cannot read path '${path}'.`);
    error.code = 'ENOENT';
    throw error;
  }),
  writeFileSync: jest.fn((path, data, options) => {
    expect(options).toBe(require('v8').serialize ? undefined : 'utf8');
    mockFs[path] = data;
  }),
}));

const object = data => Object.assign(Object.create(null), data);
const createMap = obj => new Map(Object.keys(obj).map(key => [key, obj[key]]));

// Jest toEqual does not match Map instances from different contexts
// This normalizes them for the uses cases in this test
const deepNormalize = value => {
  const stringTag = Object.prototype.toString.call(value);
  switch (stringTag) {
    case '[object Map]':
      return new Map(
        Array.from(value).map(([k, v]) => [deepNormalize(k), deepNormalize(v)]),
      );
    case '[object Object]':
      return Object.keys(value).reduce((obj, key) => {
        obj[key] = deepNormalize(value[key]);
        return obj;
      }, {});
    default:
      return value;
  }
};

let consoleWarn;
let consoleError;
let defaultConfig;
let fs;
let H;
let HasteMap;
let mockCacheManager;
let mockClocks;
let mockEmitters;
let mockEnd;
let mockWorker;
let cacheContent = null;

describe('HasteMap', () => {
  beforeEach(() => {
    jest.resetModules();

    mockEmitters = Object.create(null);
    mockFs = object({
      [path.join('/', 'project', 'fruits', 'Banana.js')]: `
        const Strawberry = require("Strawberry");
      `,
      [path.join('/', 'project', 'fruits', 'Pear.js')]: `
        const Banana = require("Banana");
        const Strawberry = require("Strawberry");
      `,
      [path.join('/', 'project', 'fruits', 'Strawberry.js')]: `
        // Strawberry!
      `,
      [path.join('/', 'project', 'fruits', '__mocks__', 'Pear.js')]: `
        const Melon = require("Melon");
      `,
      [path.join('/', 'project', 'vegetables', 'Melon.js')]: `
        // Melon!
      `,
      [path.join('/', 'project', 'video', 'video.mp4')]: Buffer.from([
        0xfa, 0xce, 0xb0, 0x0c,
      ]).toString(),
    });
    mockClocks = createMap({
      fruits: 'c:fake-clock:1',
      vegetables: 'c:fake-clock:2',
      video: 'c:fake-clock:3',
    });

    mockChangedFiles = null;

    fs = require('graceful-fs');

    consoleWarn = console.warn;
    consoleError = console.error;

    console.warn = jest.fn();
    console.error = jest.fn();

    HasteMap = require('../').default;
    mockCacheManager = {
      read: jest.fn().mockImplementation(async () => cacheContent),
      write: jest.fn().mockImplementation(async dataSnapshot => {
        cacheContent = dataSnapshot;
      }),
    };

    H = HasteMap.H;

    cacheContent = null;

    defaultConfig = {
      extensions: ['js', 'json'],
      hasteImplModulePath: require.resolve('./haste_impl.js'),
      healthCheck: {
        enabled: false,
        interval: 10000,
        timeout: 1000,
        filePrefix: '.metro-file-map-health-check',
      },
      maxWorkers: 1,
      name: 'haste-map-test',
      platforms: ['ios', 'android'],
      resetCache: false,
      rootDir: path.join('/', 'project'),
      roots: [
        path.join('/', 'project', 'fruits'),
        path.join('/', 'project', 'vegetables'),
      ],
      useWatchman: true,
      cacheManagerFactory: () => mockCacheManager,
    };
  });

  afterEach(() => {
    console.warn = consoleWarn;
    console.error = consoleError;
  });

  it('exports constants', () => {
    expect(HasteMap.H).toBe(require('../constants'));
  });

  it('matches files against a pattern', async () => {
    const {fileSystem} = await new HasteMap(defaultConfig).build();
    expect(
      fileSystem.matchFiles(
        process.platform === 'win32' ? /project\\fruits/ : /project\/fruits/,
      ),
    ).toEqual([
      path.join('/', 'project', 'fruits', 'Banana.js'),
      path.join('/', 'project', 'fruits', 'Pear.js'),
      path.join('/', 'project', 'fruits', 'Strawberry.js'),
      path.join('/', 'project', 'fruits', '__mocks__', 'Pear.js'),
    ]);

    expect(fileSystem.matchFiles(/__mocks__/)).toEqual([
      path.join('/', 'project', 'fruits', '__mocks__', 'Pear.js'),
    ]);
  });

  it('ignores files given a pattern', async () => {
    const config = {...defaultConfig, ignorePattern: /Kiwi/};
    mockFs[path.join('/', 'project', 'fruits', 'Kiwi.js')] = `
      // Kiwi!
    `;
    const {fileSystem} = await new HasteMap(config).build();
    expect(fileSystem.matchFiles(/Kiwi/)).toEqual([]);
  });

  it('ignores vcs directories without ignore pattern', async () => {
    mockFs[path.join('/', 'project', 'fruits', '.git', 'fruit-history.js')] = `
      // test
    `;
    const {fileSystem} = await new HasteMap(defaultConfig).build();
    expect(fileSystem.matchFiles('.git')).toEqual([]);
  });

  it('ignores vcs directories with ignore pattern regex', async () => {
    const config = {...defaultConfig, ignorePattern: /Kiwi/};
    mockFs[path.join('/', 'project', 'fruits', 'Kiwi.js')] = `
      // Kiwi!
    `;

    mockFs[path.join('/', 'project', 'fruits', '.git', 'fruit-history.js')] = `
      // test
    `;
    const {fileSystem} = await new HasteMap(config).build();
    expect(fileSystem.matchFiles(/Kiwi/)).toEqual([]);
    expect(fileSystem.matchFiles('.git')).toEqual([]);
  });

  it('warn on ignore pattern except for regex', async () => {
    const config = {ignorePattern: 'Kiwi', ...defaultConfig};
    mockFs['/project/fruits/Kiwi.js'] = `
      // Kiwi!
    `;

    try {
      await new HasteMap(config).build();
    } catch (err) {
      expect(err.message).toBe(
        'metro-file-map: the `ignorePattern` option must be a RegExp',
      );
    }
  });

  it('builds a haste map on a fresh cache', async () => {
    // Include these files in the map
    mockFs[
      path.join('/', 'project', 'fruits', 'node_modules', 'react', 'React.js')
    ] = `
      const Component = require("Component");
    `;
    mockFs[
      path.join(
        '/',
        'project',
        'fruits',
        'node_modules',
        'fbjs',
        'lib',
        'flatMap.js',
      )
    ] = `
      // flatMap
    `;

    // Ignore these
    mockFs[
      path.join(
        '/',
        'project',
        'fruits',
        'node_modules',
        'react',
        'node_modules',
        'fbjs',
        'lib',
        'mapObject.js',
      )
    ] = `
      // mapObject
    `;
    mockFs[
      path.join(
        '/',
        'project',
        'fruits',
        'node_modules',
        'react',
        'node_modules',
        'dummy',
        'merge.js',
      )
    ] = `
      // merge
    `;
    mockFs[
      path.join(
        '/',
        'project',
        'fruits',
        'node_modules',
        'react',
        'node_modules',
        'merge',
        'package.json',
      )
    ] = `
      {
        "name": "merge"
      }
    `;
    mockFs[
      path.join('/', 'project', 'fruits', 'node_modules', 'jest', 'Jest.js')
    ] = `
      const Test = require("Test");
    `;
    mockFs[
      path.join('/', 'project', 'fruits', 'node_modules', 'fbjs2', 'fbjs2.js')
    ] = `
      // fbjs2
    `;

    const hasteMap = new HasteMap({
      ...defaultConfig,
      mocksPattern: '__mocks__',
    });

    await hasteMap.build();

    expect(cacheContent.clocks).toEqual(mockClocks);

    expect(cacheContent.files).toEqual(
      createMap({
        [path.join('fruits', 'Banana.js')]: [
          'Banana',
          32,
          42,
          1,
          'Strawberry',
          null,
          0,
        ],
        [path.join('fruits', 'Pear.js')]: [
          'Pear',
          32,
          42,
          1,
          'Banana\0Strawberry',
          null,
          0,
        ],
        [path.join('fruits', 'Strawberry.js')]: [
          'Strawberry',
          32,
          42,
          1,
          '',
          null,
          0,
        ],
        [path.join('fruits', '__mocks__', 'Pear.js')]: [
          '',
          32,
          42,
          1,
          'Melon',
          null,
          0,
        ],
        [path.join('vegetables', 'Melon.js')]: [
          'Melon',
          32,
          42,
          1,
          '',
          null,
          0,
        ],
      }),
    );

    expect(cacheContent.map).toEqual(
      createMap({
        Banana: {
          [H.GENERIC_PLATFORM]: [path.join('fruits', 'Banana.js'), H.MODULE],
        },
        Melon: {
          [H.GENERIC_PLATFORM]: [path.join('vegetables', 'Melon.js'), H.MODULE],
        },
        Pear: {
          [H.GENERIC_PLATFORM]: [path.join('fruits', 'Pear.js'), H.MODULE],
        },
        Strawberry: {
          [H.GENERIC_PLATFORM]: [
            path.join('fruits', 'Strawberry.js'),
            H.MODULE,
          ],
        },
      }),
    );

    expect(cacheContent.mocks).toEqual(
      createMap({
        Pear: path.join('fruits', '__mocks__', 'Pear.js'),
      }),
    );

    // The cache file must exactly mirror the data structure returned from a
    // read
    expect(deepNormalize(await hasteMap.read())).toEqual(cacheContent);
  });

  it('throws if both symlinks and watchman is enabled', () => {
    expect(
      () => new HasteMap({...defaultConfig, enableSymlinks: true}),
    ).toThrow(
      'Set either `enableSymlinks` to false or `useWatchman` to false.',
    );
    expect(
      () =>
        new HasteMap({
          ...defaultConfig,
          enableSymlinks: true,
          useWatchman: true,
        }),
    ).toThrow(
      'Set either `enableSymlinks` to false or `useWatchman` to false.',
    );

    expect(
      () =>
        new HasteMap({
          ...defaultConfig,
          enableSymlinks: false,
          useWatchman: true,
        }),
    ).not.toThrow();

    expect(
      () =>
        new HasteMap({
          ...defaultConfig,
          enableSymlinks: true,
          useWatchman: false,
        }),
    ).not.toThrow();
  });

  describe('builds a haste map on a fresh cache with SHA-1s', () => {
    it.each([false, true])('uses watchman: %s', async useWatchman => {
      const node = require('../crawlers/node');

      node.mockImplementation(options => {
        // The node crawler returns "null" for the SHA-1.
        const changedFiles = createMap({
          [path.join('fruits', 'Banana.js')]: [
            'Banana',
            32,
            42,
            0,
            'Strawberry',
            null,
            0,
          ],
          [path.join('fruits', 'Pear.js')]: [
            'Pear',
            32,
            42,
            0,
            'Banana\0Strawberry',
            null,
            0,
          ],
          [path.join('fruits', 'Strawberry.js')]: [
            'Strawberry',
            32,
            42,
            0,
            '',
            null,
            0,
          ],
          [path.join('fruits', '__mocks__', 'Pear.js')]: [
            '',
            32,
            42,
            0,
            'Melon',
            null,
            0,
          ],
          [path.join('vegetables', 'Melon.js')]: [
            'Melon',
            32,
            42,
            0,
            '',
            null,
            0,
          ],
        });

        return Promise.resolve({
          changedFiles,
          removedFiles: new Map(),
        });
      });

      const hasteMap = new HasteMap({
        ...defaultConfig,
        computeSha1: true,
        maxWorkers: 1,
        useWatchman,
      });

      await hasteMap.build();

      expect(cacheContent.files).toEqual(
        createMap({
          [path.join('fruits', 'Banana.js')]: [
            'Banana',
            32,
            42,
            1,
            'Strawberry',
            '7772b628e422e8cf59c526be4bb9f44c0898e3d1',
            0,
          ],
          [path.join('fruits', 'Pear.js')]: [
            'Pear',
            32,
            42,
            1,
            'Banana\0Strawberry',
            '89d0c2cc11dcc5e1df50b8af04ab1b597acfba2f',
            0,
          ],
          [path.join('fruits', 'Strawberry.js')]: [
            'Strawberry',
            32,
            42,
            1,
            '',
            'e8aa38e232b3795f062f1d777731d9240c0f8c25',
            0,
          ],
          [path.join('fruits', '__mocks__', 'Pear.js')]: [
            '',
            32,
            42,
            1,
            'Melon',
            '8d40afbb6e2dc78e1ba383b6d02cafad35cceef2',
            0,
          ],
          [path.join('vegetables', 'Melon.js')]: [
            'Melon',
            32,
            42,
            1,
            '',
            'f16ccf6f2334ceff2ddb47628a2c5f2d748198ca',
            0,
          ],
        }),
      );

      expect(deepNormalize(await hasteMap.read())).toEqual(cacheContent);
    });
  });

  it('does not crawl native files even if requested to do so', async () => {
    mockFs[path.join('/', 'project', 'video', 'IRequireAVideo.js')] = `
      module.exports = require("./video.mp4");
    `;

    const hasteMap = new HasteMap({
      ...defaultConfig,
      extensions: [...defaultConfig.extensions],
      roots: [...defaultConfig.roots, path.join('/', 'project', 'video')],
    });

    await hasteMap.build();
    const data = cacheContent;

    expect(data.map.get('IRequireAVideo')).toBeDefined();
    expect(data.files.get(path.join('video', 'video.mp4'))).toBeDefined();
    expect(fs.readFileSync).not.toBeCalledWith(
      path.join('video', 'video.mp4'),
      'utf8',
    );
  });

  it('retains all files if `retainAllFiles` is specified', async () => {
    mockFs[
      path.join('/', 'project', 'fruits', 'node_modules', 'fbjs', 'fbjs.js')
    ] = `
      // fbjs!
    `;

    const hasteMap = new HasteMap({
      ...defaultConfig,
      mocksPattern: '__mocks__',
      retainAllFiles: true,
    });

    await hasteMap.build();

    // Expect the node module to be part of files but make sure it wasn't
    // read.
    expect(
      cacheContent.files.get(
        path.join('fruits', 'node_modules', 'fbjs', 'fbjs.js'),
      ),
    ).toEqual(['', 32, 42, 0, [], null, 0]);

    expect(cacheContent.map.get('fbjs')).not.toBeDefined();

    // 5 modules - the node_module
    expect(fs.readFileSync.mock.calls.length).toBe(5);
  });

  it('warns on duplicate mock files', async () => {
    expect.assertions(1);

    // Duplicate mock files for blueberry
    mockFs[
      path.join(
        '/',
        'project',
        'fruits1',
        '__mocks__',
        'subdir',
        'Blueberry.js',
      )
    ] = `
      // Blueberry
    `;
    mockFs[
      path.join(
        '/',
        'project',
        'fruits2',
        '__mocks__',
        'subdir',
        'Blueberry.js',
      )
    ] = `
      // Blueberry too!
    `;

    try {
      await new HasteMap({
        mocksPattern: '__mocks__',
        throwOnModuleCollision: true,
        ...defaultConfig,
      }).build();
    } catch {
      expect(
        console.error.mock.calls[0][0].replace(/\\/g, '/'),
      ).toMatchSnapshot();
    }
  });

  it('warns on duplicate module ids', async () => {
    mockFs[path.join('/', 'project', 'fruits', 'other', 'Strawberry.js')] = `
      const Banana = require("Banana");
    `;

    await new HasteMap(defaultConfig).build();

    // Duplicate modules are removed so that it doesn't cause
    // non-determinism later on.
    expect(
      cacheContent.map.get('Strawberry')[H.GENERIC_PLATFORM],
    ).not.toBeDefined();

    expect(console.warn.mock.calls[0][0].replace(/\\/g, '/')).toMatchSnapshot();
  });

  it('warns on duplicate module ids only once', async () => {
    mockFs[path.join('/', 'project', 'fruits', 'other', 'Strawberry.js')] = `
      const Banana = require("Banana");
    `;

    await new HasteMap(defaultConfig).build();
    expect(console.warn).toHaveBeenCalledTimes(1);

    await new HasteMap(defaultConfig).build();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('throws on duplicate module ids if "throwOnModuleCollision" is set to true', async () => {
    expect.assertions(1);
    // Raspberry thinks it is a Strawberry
    mockFs[path.join('/', 'project', 'fruits', 'another', 'Strawberry.js')] = `
      const Banana = require("Banana");
    `;

    try {
      await new HasteMap({
        throwOnModuleCollision: true,
        ...defaultConfig,
      }).build();
    } catch (err) {
      expect(err.message).toBe(
        'Duplicated files or mocks. Please check the console for more info',
      );
    }
  });

  it('splits up modules by platform', async () => {
    mockFs = Object.create(null);
    mockFs[path.join('/', 'project', 'fruits', 'Strawberry.js')] = `
      const Banana = require("Banana");
    `;

    mockFs[path.join('/', 'project', 'fruits', 'Strawberry.ios.js')] = `
      const Raspberry = require("Raspberry");
    `;

    mockFs[path.join('/', 'project', 'fruits', 'Strawberry.android.js')] = `
      const Blackberry = require("Blackberry");
    `;

    await new HasteMap(defaultConfig).build();

    expect(cacheContent.files).toEqual(
      createMap({
        [path.join('fruits', 'Strawberry.android.js')]: [
          'Strawberry',
          32,
          42,
          1,
          'Blackberry',
          null,
          0,
        ],
        [path.join('fruits', 'Strawberry.ios.js')]: [
          'Strawberry',
          32,
          42,
          1,
          'Raspberry',
          null,
          0,
        ],
        [path.join('fruits', 'Strawberry.js')]: [
          'Strawberry',
          32,
          42,
          1,
          'Banana',
          null,
          0,
        ],
      }),
    );

    expect(cacheContent.map).toEqual(
      createMap({
        Strawberry: {
          [H.GENERIC_PLATFORM]: [
            path.join('fruits', 'Strawberry.js'),
            H.MODULE,
          ],
          android: [path.join('fruits', 'Strawberry.android.js'), H.MODULE],
          ios: [path.join('fruits', 'Strawberry.ios.js'), H.MODULE],
        },
      }),
    );
  });

  it('does not access the file system on a warm cache with no changes', async () => {
    await new HasteMap(defaultConfig).build();
    const initialData = cacheContent;

    // First run should attempt to read the cache, but there will be no result
    expect(mockCacheManager.read).toHaveBeenCalledTimes(1);
    // and it should write a new cache
    expect(mockCacheManager.write).toHaveBeenCalledTimes(1);

    // The first run should access the file system five times for the files in
    // the system.
    expect(fs.readFileSync.mock.calls.length).toBe(5);

    fs.readFileSync.mockClear();

    // Explicitly mock that no files have changed.
    mockChangedFiles = Object.create(null);

    // Watchman would give us different clocks.
    mockClocks = createMap({
      fruits: 'c:fake-clock:3',
      vegetables: 'c:fake-clock:4',
    });

    await new HasteMap(defaultConfig).build();
    const data = cacheContent;

    // Expect the cache to have been read again
    expect(mockCacheManager.read).toHaveBeenCalledTimes(2);
    // Expect no fs reads, because there have been no changes
    expect(fs.readFileSync.mock.calls.length).toBe(0);
    expect(deepNormalize(data.clocks)).toEqual(mockClocks);
    expect(deepNormalize(data.files)).toEqual(initialData.files);
    expect(deepNormalize(data.map)).toEqual(initialData.map);
  });

  it('only does minimal file system access when files change', async () => {
    // Run with a cold cache initially
    await new HasteMap(defaultConfig).build();
    const initialData = cacheContent;
    fs.readFileSync.mockClear();
    expect(mockCacheManager.read).toHaveBeenCalledTimes(1);

    // Let's assume one JS file has changed.
    mockChangedFiles = object({
      [path.join('/', 'project', 'fruits', 'Banana.js')]: `
            const Kiwi = require("Kiwi");
          `,
    });

    // Watchman would give us different clocks for `/project/fruits`.
    mockClocks = createMap({
      fruits: 'c:fake-clock:3',
      vegetables: 'c:fake-clock:2',
    });

    await new HasteMap(defaultConfig).build();
    const data = cacheContent;

    expect(mockCacheManager.read).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync).toBeCalledWith(
      path.join('/', 'project', 'fruits', 'Banana.js'),
      'utf8',
    );

    expect(deepNormalize(data.clocks)).toEqual(mockClocks);

    const files = new Map(initialData.files);
    files.set(path.join('fruits', 'Banana.js'), [
      'Banana',
      32,
      42,
      1,
      'Kiwi',
      null,
      0,
    ]);

    expect(deepNormalize(data.files)).toEqual(files);

    const map = new Map(initialData.map);
    expect(deepNormalize(data.map)).toEqual(map);
  });

  it('correctly handles file deletions', async () => {
    await new HasteMap(defaultConfig).build();
    const initialData = cacheContent;
    fs.readFileSync.mockClear();

    // Let's assume one JS file was removed.
    delete mockFs[path.join('/', 'project', 'fruits', 'Banana.js')];
    mockChangedFiles = object({
      [path.join('/', 'project', 'fruits', 'Banana.js')]: null,
    });

    // Watchman would give us different clocks for `/project/fruits`.
    mockClocks = createMap({
      fruits: 'c:fake-clock:3',
      vegetables: 'c:fake-clock:2',
    });

    await new HasteMap(defaultConfig).build();
    const data = cacheContent;

    const files = new Map(initialData.files);
    files.delete(path.join('fruits', 'Banana.js'));
    expect(deepNormalize(data.files)).toEqual(files);

    const map = new Map(initialData.map);
    map.delete('Banana');
    expect(deepNormalize(data.map)).toEqual(map);
  });

  it('correctly handles platform-specific file additions', async () => {
    mockFs = Object.create(null);
    mockFs[path.join('/', 'project', 'fruits', 'Strawberry.js')] = `
      const Banana = require("Banana");
    `;
    await new HasteMap(defaultConfig).build();
    expect(cacheContent.map.get('Strawberry')).toEqual({
      g: [path.join('fruits', 'Strawberry.js'), 0],
    });

    delete mockFs[path.join('/', 'project', 'fruits', 'Strawberry.ios.js')];
    mockChangedFiles = object({
      [path.join('/', 'project', 'fruits', 'Strawberry.ios.js')]: `
        const Raspberry = require("Raspberry");
      `,
    });
    mockClocks = createMap({fruits: 'c:fake-clock:3'});
    await new HasteMap(defaultConfig).build();
    expect(cacheContent.map.get('Strawberry')).toEqual({
      g: [path.join('fruits', 'Strawberry.js'), 0],
      ios: [path.join('fruits', 'Strawberry.ios.js'), 0],
    });
  });

  it('correctly handles platform-specific file deletions', async () => {
    mockFs = Object.create(null);
    mockFs[path.join('/', 'project', 'fruits', 'Strawberry.js')] = `
      const Banana = require("Banana");
    `;
    mockFs[path.join('/', 'project', 'fruits', 'Strawberry.ios.js')] = `
      const Raspberry = require("Raspberry");
    `;
    await new HasteMap(defaultConfig).build();
    expect(cacheContent.map.get('Strawberry')).toEqual({
      g: [path.join('fruits', 'Strawberry.js'), 0],
      ios: [path.join('fruits', 'Strawberry.ios.js'), 0],
    });

    delete mockFs[path.join('/', 'project', 'fruits', 'Strawberry.ios.js')];
    mockChangedFiles = object({
      [path.join('/', 'project', 'fruits', 'Strawberry.ios.js')]: null,
    });
    mockClocks = createMap({fruits: 'c:fake-clock:3'});
    await new HasteMap(defaultConfig).build();
    expect(cacheContent.map.get('Strawberry')).toEqual({
      g: [path.join('fruits', 'Strawberry.js'), 0],
    });
  });

  it('correctly handles platform-specific file renames', async () => {
    mockFs = Object.create(null);
    mockFs[path.join('/', 'project', 'fruits', 'Strawberry.ios.js')] = `
      const Raspberry = require("Raspberry");
    `;
    await new HasteMap(defaultConfig).build();
    expect(cacheContent.map.get('Strawberry')).toEqual({
      ios: [path.join('fruits', 'Strawberry.ios.js'), 0],
    });

    delete mockFs[path.join('/', 'project', 'fruits', 'Strawberry.ios.js')];
    mockChangedFiles = object({
      [path.join('/', 'project', 'fruits', 'Strawberry.ios.js')]: null,
      [path.join('/', 'project', 'fruits', 'Strawberry.js')]: `
        const Banana = require("Banana");
      `,
    });
    mockClocks = createMap({fruits: 'c:fake-clock:3'});
    await new HasteMap(defaultConfig).build();
    expect(cacheContent.map.get('Strawberry')).toEqual({
      g: [path.join('fruits', 'Strawberry.js'), 0],
    });
  });

  describe('duplicate modules', () => {
    beforeEach(async () => {
      mockFs[
        path.join('/', 'project', 'fruits', 'another', 'Strawberry.js')
      ] = `
        const Blackberry = require("Blackberry");
      `;

      await new HasteMap(defaultConfig).build();
      expect(deepNormalize(cacheContent.duplicates)).toEqual(
        createMap({
          Strawberry: createMap({
            g: createMap({
              [path.join('fruits', 'Strawberry.js')]: H.MODULE,
              [path.join('fruits', 'another', 'Strawberry.js')]: H.MODULE,
            }),
          }),
        }),
      );
      expect(cacheContent.map.get('Strawberry')).toEqual({});
    });

    it('recovers when a duplicate file is deleted', async () => {
      delete mockFs[
        path.join('/', 'project', 'fruits', 'another', 'Strawberry.js')
      ];
      mockChangedFiles = object({
        [path.join('/', 'project', 'fruits', 'another', 'Strawberry.js')]: null,
      });
      mockClocks = createMap({
        fruits: 'c:fake-clock:3',
        vegetables: 'c:fake-clock:2',
      });

      await new HasteMap(defaultConfig).build();
      expect(deepNormalize(cacheContent.duplicates)).toEqual(new Map());
      expect(cacheContent.map.get('Strawberry')).toEqual({
        g: [path.join('fruits', 'Strawberry.js'), H.MODULE],
      });
      // Make sure the other files are not affected.
      expect(cacheContent.map.get('Banana')).toEqual({
        g: [path.join('fruits', 'Banana.js'), H.MODULE],
      });
    });

    it('recovers with the correct type when a duplicate file is deleted', async () => {
      mockFs[
        path.join('/', 'project', 'fruits', 'strawberryPackage', 'package.json')
      ] = `
        {"name": "Strawberry"}
      `;

      await new HasteMap(defaultConfig).build();

      expect(deepNormalize(cacheContent.duplicates)).toEqual(
        createMap({
          Strawberry: createMap({
            g: createMap({
              [path.join('fruits', 'Strawberry.js')]: H.MODULE,
              [path.join('fruits', 'another', 'Strawberry.js')]: H.MODULE,
              [path.join('fruits', 'strawberryPackage', 'package.json')]:
                H.PACKAGE,
            }),
          }),
        }),
      );

      delete mockFs[
        path.join('/', 'project', 'fruits', 'another', 'Strawberry.js')
      ];
      delete mockFs[
        path.join('/', 'project', 'fruits', 'strawberryPackage', 'package.json')
      ];

      mockChangedFiles = object({
        [path.join('/', 'project', 'fruits', 'another', 'Strawberry.js')]: null,
        [path.join(
          '/',
          'project',
          'fruits',
          'strawberryPackage',
          'package.json',
        )]: null,
      });
      mockClocks = createMap({
        fruits: 'c:fake-clock:4',
      });

      await new HasteMap(defaultConfig).build();

      expect(deepNormalize(cacheContent.duplicates)).toEqual(new Map());
      expect(cacheContent.map.get('Strawberry')).toEqual({
        g: [path.join('fruits', 'Strawberry.js'), H.MODULE],
      });
    });

    it('recovers when a duplicate module is renamed', async () => {
      mockChangedFiles = object({
        [path.join('/', 'project', 'fruits', 'another', 'Pineapple.js')]: `
          const Blackberry = require("Blackberry");
        `,
        [path.join('/', 'project', 'fruits', 'another', 'Strawberry.js')]: null,
      });
      mockClocks = createMap({
        fruits: 'c:fake-clock:3',
        vegetables: 'c:fake-clock:2',
      });

      await new HasteMap(defaultConfig).build();
      expect(deepNormalize(cacheContent.duplicates)).toEqual(new Map());
      expect(cacheContent.map.get('Strawberry')).toEqual({
        g: [path.join('fruits', 'Strawberry.js'), H.MODULE],
      });
      expect(cacheContent.map.get('Pineapple')).toEqual({
        g: [path.join('fruits', 'another', 'Pineapple.js'), H.MODULE],
      });
      // Make sure the other files are not affected.
      expect(cacheContent.map.get('Banana')).toEqual({
        g: [path.join('fruits', 'Banana.js'), H.MODULE],
      });
    });
  });

  it('ignores files that do not exist', async () => {
    const watchman = require('../crawlers/watchman');
    const mockImpl = watchman.getMockImplementation();
    // Wrap the watchman mock and add an invalid file to the file list.
    const invalidFilePath = path.join('fruits', 'invalid', 'file.js');
    watchman.mockImplementation(async options => {
      const {changedFiles} = await mockImpl(options);
      changedFiles.set(invalidFilePath, ['', 34, 44, 0, [], null, 0]);
      return {
        changedFiles,
        removedFiles: new Map(),
      };
    });

    await new HasteMap(defaultConfig).build();
    expect(cacheContent.files.size).toBe(5);

    // Ensure this file is not part of the file list.
    expect(cacheContent.files.get(invalidFilePath)).toBe(undefined);
  });

  it('distributes work across workers', async () => {
    const jestWorker = require('jest-worker').Worker;
    const path = require('path');
    const dependencyExtractor = path.join(__dirname, 'dependencyExtractor.js');
    await new HasteMap({
      ...defaultConfig,
      dependencyExtractor,
      hasteImplModulePath: undefined,
      maxWorkers: 4,
    }).build();

    expect(jestWorker.mock.calls.length).toBe(1);

    expect(mockWorker.mock.calls.length).toBe(5);

    expect(mockWorker.mock.calls).toEqual([
      [
        {
          computeDependencies: true,
          computeSha1: false,
          dependencyExtractor,
          filePath: path.join('/', 'project', 'fruits', 'Banana.js'),
          hasteImplModulePath: undefined,
          rootDir: path.join('/', 'project'),
        },
      ],
      [
        {
          computeDependencies: true,
          computeSha1: false,
          dependencyExtractor,
          filePath: path.join('/', 'project', 'fruits', 'Pear.js'),
          hasteImplModulePath: undefined,
          rootDir: path.join('/', 'project'),
        },
      ],
      [
        {
          computeDependencies: true,
          computeSha1: false,
          dependencyExtractor,
          filePath: path.join('/', 'project', 'fruits', 'Strawberry.js'),
          hasteImplModulePath: undefined,
          rootDir: path.join('/', 'project'),
        },
      ],
      [
        {
          computeDependencies: true,
          computeSha1: false,
          dependencyExtractor,
          filePath: path.join('/', 'project', 'fruits', '__mocks__', 'Pear.js'),
          hasteImplModulePath: undefined,
          rootDir: path.join('/', 'project'),
        },
      ],
      [
        {
          computeDependencies: true,
          computeSha1: false,
          dependencyExtractor,
          filePath: path.join('/', 'project', 'vegetables', 'Melon.js'),
          hasteImplModulePath: undefined,
          rootDir: path.join('/', 'project'),
        },
      ],
    ]);

    expect(mockEnd).toBeCalled();
  });

  it('tries to crawl using node as a fallback', async () => {
    const watchman = require('../crawlers/watchman');
    const node = require('../crawlers/node');

    watchman.mockImplementation(() => {
      throw new Error('watchman error');
    });
    node.mockImplementation(options => {
      return Promise.resolve({
        changedFiles: createMap({
          [path.join('fruits', 'Banana.js')]: ['', 32, 42, 0, '', null, 0],
        }),
        removedFiles: new Map(),
      });
    });

    await new HasteMap(defaultConfig).build();
    expect(watchman).toBeCalled();
    expect(node).toBeCalled();

    expect(cacheContent.files).toEqual(
      createMap({
        [path.join('fruits', 'Banana.js')]: [
          'Banana',
          32,
          42,
          1,
          'Strawberry',
          null,
          0,
        ],
      }),
    );

    expect(console.warn.mock.calls[0][0]).toMatchSnapshot();
  });

  it('tries to crawl using node as a fallback when promise fails once', async () => {
    const watchman = require('../crawlers/watchman');
    const node = require('../crawlers/node');

    watchman.mockImplementation(() =>
      Promise.reject(new Error('watchman error')),
    );
    node.mockImplementation(options => {
      return Promise.resolve({
        changedFiles: createMap({
          [path.join('fruits', 'Banana.js')]: ['', 32, 42, 0, '', null, 0],
        }),
        removedFiles: new Map(),
      });
    });

    await new HasteMap(defaultConfig).build();

    expect(watchman).toBeCalled();
    expect(node).toBeCalled();

    expect(cacheContent.files).toEqual(
      createMap({
        [path.join('fruits', 'Banana.js')]: [
          'Banana',
          32,
          42,
          1,
          'Strawberry',
          null,
          0,
        ],
      }),
    );
  });

  it('stops crawling when both crawlers fail', async () => {
    expect.assertions(1);
    const watchman = require('../crawlers/watchman');
    const node = require('../crawlers/node');

    watchman.mockImplementation(() =>
      Promise.reject(new Error('watchman error')),
    );

    node.mockImplementation((roots, extensions, ignore, data) =>
      Promise.reject(new Error('node error')),
    );

    try {
      await new HasteMap(defaultConfig).build();
    } catch (error) {
      expect(error.message).toEqual(
        'Crawler retry failed:\n' +
          '  Original error: watchman error\n' +
          '  Retry error: node error\n',
      );
    }
  });

  describe('file system changes processing', () => {
    function waitForItToChange(hasteMap) {
      return new Promise(resolve => {
        hasteMap.once('change', resolve);
      });
    }

    function mockDeleteFile(dirPath, filePath) {
      const e = mockEmitters[dirPath];
      e.emit('all', 'delete', filePath, dirPath, undefined);
    }

    function hm_it(title, fn, options) {
      options = options || {};
      (options.only ? it.only : it)(title, async () => {
        if (options.mockFs) {
          mockFs = options.mockFs;
        }
        const watchConfig = {...defaultConfig, watch: true};
        const hm = new HasteMap(watchConfig);
        await hm.build();
        try {
          await fn(hm);
        } finally {
          hm.end();
        }
      });
    }

    hm_it('build returns a "live" fileSystem and hasteModuleMap', async hm => {
      const {fileSystem, hasteModuleMap} = await hm.build();
      const filePath = path.join('/', 'project', 'fruits', 'Banana.js');
      expect(fileSystem.getModuleName(filePath)).toBeDefined();
      expect(hasteModuleMap.getModule('Banana')).toBe(filePath);
      mockDeleteFile(path.join('/', 'project', 'fruits'), 'Banana.js');
      mockDeleteFile(path.join('/', 'project', 'fruits'), 'Banana.js');
      const {eventsQueue} = await waitForItToChange(hm);
      expect(eventsQueue).toHaveLength(1);
      const deletedBanana = {
        filePath,
        metadata: undefined,
        type: 'delete',
      };
      expect(eventsQueue).toEqual([deletedBanana]);
      // Verify that the initial result has been updated
      expect(fileSystem.getModuleName(filePath)).toBeNull();
      expect(hasteModuleMap.getModule('Banana')).toBeNull();
    });

    const MOCK_CHANGE_FILE = {
      type: 'f',
      modifiedTime: 45,
      size: 55,
    };

    const MOCK_CHANGE_FOLDER = {
      type: 'd',
      modifiedTime: 45,
      size: 55,
    };

    hm_it('handles several change events at once', async hm => {
      const {fileSystem, hasteModuleMap} = await hm.build();
      mockFs[path.join('/', 'project', 'fruits', 'Tomato.js')] = `
        // Tomato!
      `;
      mockFs[path.join('/', 'project', 'fruits', 'Pear.js')] = `
        // Pear!
      `;
      const e = mockEmitters[path.join('/', 'project', 'fruits')];
      e.emit(
        'all',
        'add',
        'Tomato.js',
        path.join('/', 'project', 'fruits'),
        MOCK_CHANGE_FILE,
      );
      e.emit(
        'all',
        'change',
        'Pear.js',
        path.join('/', 'project', 'fruits'),
        MOCK_CHANGE_FILE,
      );
      const {eventsQueue} = await waitForItToChange(hm);
      expect(eventsQueue).toEqual([
        {
          filePath: path.join('/', 'project', 'fruits', 'Tomato.js'),
          metadata: MOCK_CHANGE_FILE,
          type: 'add',
        },
        {
          filePath: path.join('/', 'project', 'fruits', 'Pear.js'),
          metadata: MOCK_CHANGE_FILE,
          type: 'change',
        },
      ]);
      expect(
        fileSystem.getModuleName(
          path.join('/', 'project', 'fruits', 'Tomato.js'),
        ),
      ).not.toBeNull();
      expect(hasteModuleMap.getModule('Tomato')).toBeDefined();
      expect(hasteModuleMap.getModule('Pear')).toBe(
        path.join('/', 'project', 'fruits', 'Pear.js'),
      );
    });

    hm_it('does not emit duplicate change events', async hm => {
      const e = mockEmitters[path.join('/', 'project', 'fruits')];
      e.emit(
        'all',
        'change',
        'tomato.js',
        path.join('/', 'project', 'fruits'),
        MOCK_CHANGE_FILE,
      );
      e.emit(
        'all',
        'change',
        'tomato.js',
        path.join('/', 'project', 'fruits'),
        MOCK_CHANGE_FILE,
      );
      const {eventsQueue} = await waitForItToChange(hm);
      expect(eventsQueue).toHaveLength(1);
    });

    hm_it(
      'emits a change even if a file in node_modules has changed',
      async hm => {
        const {fileSystem} = await hm.build();
        const e = mockEmitters[path.join('/', 'project', 'fruits')];
        e.emit(
          'all',
          'add',
          'apple.js',
          path.join('/', 'project', 'fruits', 'node_modules', ''),
          MOCK_CHANGE_FILE,
        );
        const {eventsQueue} = await waitForItToChange(hm);
        const filePath = path.join(
          '/',
          'project',
          'fruits',
          'node_modules',
          'apple.js',
        );
        expect(eventsQueue).toHaveLength(1);
        expect(eventsQueue).toEqual([
          {filePath, metadata: MOCK_CHANGE_FILE, type: 'add'},
        ]);
        expect(fileSystem.getModuleName(filePath)).toBeDefined();
      },
    );

    hm_it(
      'correctly tracks changes to both platform-specific versions of a single module name',
      async hm => {
        const {hasteModuleMap, fileSystem} = await hm.build();
        expect(hasteModuleMap.getModule('Orange', 'ios')).toBeTruthy();
        expect(hasteModuleMap.getModule('Orange', 'android')).toBeTruthy();
        const e = mockEmitters[path.join('/', 'project', 'fruits')];
        e.emit(
          'all',
          'change',
          'Orange.ios.js',
          path.join('/', 'project', 'fruits'),
          MOCK_CHANGE_FILE,
        );
        e.emit(
          'all',
          'change',
          'Orange.android.js',
          path.join('/', 'project', 'fruits'),
          MOCK_CHANGE_FILE,
        );
        const {eventsQueue} = await waitForItToChange(hm);
        expect(eventsQueue).toHaveLength(2);
        expect(eventsQueue).toEqual([
          {
            filePath: path.join('/', 'project', 'fruits', 'Orange.ios.js'),
            metadata: MOCK_CHANGE_FILE,
            type: 'change',
          },
          {
            filePath: path.join('/', 'project', 'fruits', 'Orange.android.js'),
            metadata: MOCK_CHANGE_FILE,
            type: 'change',
          },
        ]);
        expect(
          fileSystem.getModuleName(
            path.join('/', 'project', 'fruits', 'Orange.ios.js'),
          ),
        ).toBeTruthy();
        expect(
          fileSystem.getModuleName(
            path.join('/', 'project', 'fruits', 'Orange.android.js'),
          ),
        ).toBeTruthy();
        const iosVariant = hasteModuleMap.getModule('Orange', 'ios');
        expect(iosVariant).toBe(
          path.join('/', 'project', 'fruits', 'Orange.ios.js'),
        );
        const androidVariant = hasteModuleMap.getModule('Orange', 'android');
        expect(androidVariant).toBe(
          path.join('/', 'project', 'fruits', 'Orange.android.js'),
        );
      },
      {
        mockFs: {
          [path.join('/', 'project', 'fruits', 'Orange.android.js')]: `
            // Orange Android!
          `,
          [path.join('/', 'project', 'fruits', 'Orange.ios.js')]: `
            // Orange iOS!
          `,
        },
      },
    );

    describe('recovery from duplicate module IDs', () => {
      async function setupDuplicates(hm) {
        const {fileSystem, hasteModuleMap} = await hm.build();
        mockFs[path.join('/', 'project', 'fruits', 'Pear.js')] = `
          // Pear!
        `;
        mockFs[path.join('/', 'project', 'fruits', 'another', 'Pear.js')] = `
          // Pear too!
        `;
        const e = mockEmitters[path.join('/', 'project', 'fruits')];
        e.emit(
          'all',
          'change',
          'Pear.js',
          path.join('/', 'project', 'fruits'),
          MOCK_CHANGE_FILE,
        );
        e.emit(
          'all',
          'add',
          'Pear.js',
          path.join('/', 'project', 'fruits', 'another'),
          MOCK_CHANGE_FILE,
        );
        await waitForItToChange(hm);
        expect(
          fileSystem.exists(
            path.join('/', 'project', 'fruits', 'another', 'Pear.js'),
          ),
        ).toBe(true);
        try {
          hasteModuleMap.getModule('Pear');
          throw new Error('should be unreachable');
        } catch (error) {
          const {
            DuplicateHasteCandidatesError,
          } = require('../lib/DuplicateHasteCandidatesError');
          expect(error).toBeInstanceOf(DuplicateHasteCandidatesError);
          expect(error.hasteName).toBe('Pear');
          expect(error.platform).toBe('g');
          expect(error.supportsNativePlatform).toBe(false);
          expect(error.duplicatesSet).toEqual(
            createMap({
              [path.join('/', 'project', 'fruits', 'Pear.js')]: H.MODULE,
              [path.join('/', 'project', 'fruits', 'another', 'Pear.js')]:
                H.MODULE,
            }),
          );
          expect(error.message.replace(/\\/g, '/')).toMatchSnapshot();
        }
      }

      hm_it(
        'recovers when the oldest version of the duplicates is fixed',
        async hm => {
          const {hasteModuleMap} = await hm.build();
          await setupDuplicates(hm);
          mockFs[path.join('/', 'project', 'fruits', 'Pear.js')] = null;
          mockFs[path.join('/', 'project', 'fruits', 'Pear2.js')] = `
            // Pear!
          `;
          const e = mockEmitters[path.join('/', 'project', 'fruits')];
          e.emit(
            'all',
            'delete',
            'Pear.js',
            path.join('/', 'project', 'fruits'),
            MOCK_CHANGE_FILE,
          );
          e.emit(
            'all',
            'add',
            'Pear2.js',
            path.join('/', 'project', 'fruits'),
            MOCK_CHANGE_FILE,
          );
          await waitForItToChange(hm);
          expect(hasteModuleMap.getModule('Pear')).toBe(
            path.join('/', 'project', 'fruits', 'another', 'Pear.js'),
          );
          expect(hasteModuleMap.getModule('Pear2')).toBe(
            path.join('/', 'project', 'fruits', 'Pear2.js'),
          );
        },
      );

      hm_it('recovers when the most recent duplicate is fixed', async hm => {
        const {hasteModuleMap} = await hm.build();
        await setupDuplicates(hm);
        mockFs[path.join('/', 'project', 'fruits', 'another', 'Pear.js')] =
          null;
        mockFs[path.join('/', 'project', 'fruits', 'another', 'Pear2.js')] = `
          // Pear too!
        `;
        const e = mockEmitters[path.join('/', 'project', 'fruits')];
        e.emit(
          'all',
          'add',
          'Pear2.js',
          path.join('/', 'project', 'fruits', 'another'),
          MOCK_CHANGE_FILE,
        );
        e.emit(
          'all',
          'delete',
          'Pear.js',
          path.join('/', 'project', 'fruits', 'another'),
          MOCK_CHANGE_FILE,
        );
        await waitForItToChange(hm);
        expect(hasteModuleMap.getModule('Pear')).toBe(
          path.join('/', 'project', 'fruits', 'Pear.js'),
        );
        expect(hasteModuleMap.getModule('Pear2')).toBe(
          path.join('/', 'project', 'fruits', 'another', 'Pear2.js'),
        );
      });

      hm_it('ignore directories', async hm => {
        const e = mockEmitters[path.join('/', 'project', 'fruits')];
        e.emit(
          'all',
          'change',
          'tomato.js',
          path.join('/', 'project', 'fruits'),
          MOCK_CHANGE_FOLDER,
        );
        e.emit(
          'all',
          'change',
          'tomato.js',
          path.join('/', 'project', 'fruits', 'tomato.js', 'index.js'),
          MOCK_CHANGE_FILE,
        );
        const {eventsQueue} = await waitForItToChange(hm);
        expect(eventsQueue).toHaveLength(1);
      });
    });
  });
});

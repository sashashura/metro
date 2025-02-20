/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 * @oncall metro_bundler
 */

'use strict';

const {add, add0, add1, get0, get1, inc, neg, sub, sub1} = require('../ob1');

const FORTY_TWO_0 = add0(42);
const FORTY_TWO_1 = add1(41);

describe('ob1', () => {
  test('add', () => {
    expect(get0(add(FORTY_TWO_0, 3))).toBe(45);
    expect(get1(add(FORTY_TWO_1, 3))).toBe(45);
  });

  test('sub', () => {
    expect(get0(sub(FORTY_TWO_0, 3))).toBe(39);
    expect(get1(sub(FORTY_TWO_1, 3))).toBe(39);
  });

  test('neg', () => {
    expect(get0(neg(FORTY_TWO_0))).toBe(-42);
  });

  test('inc', () => {
    expect(get0(inc(FORTY_TWO_0))).toBe(43);
    expect(get1(inc(FORTY_TWO_1))).toBe(43);
  });

  test('add1', () => {
    expect(get1(add1(FORTY_TWO_0))).toBe(43);
  });

  test('sub1', () => {
    expect(get0(sub1(FORTY_TWO_1))).toBe(41);
  });
});

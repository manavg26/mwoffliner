import test from 'blue-tape';
import { execute } from '../src/mwoffliner.lib';

import rimraf from 'rimraf';
// import { ZimReader } from '@openzim/libzim';
// tslint:disable-next-line: no-var-requires
require('dotenv').config();

const now = new Date();
const testId = `mwo-test-${+now}`;

const parameters = {
    mwUrl: `https://bm.wikipedia.org`,
    adminEmail: `test@kiwix.org`,
    outputDirectory: testId,
    redis: process.env.REDIS,
    format: ['nopic'],
};

test('Simple articleList', async (t) => {
    const outFiles = await execute(parameters);

    t.equal(outFiles.length, 1, `Created 1 output`);

    t.ok(true, 'Scraped BM Full');
    // TODO: clear test dir
    rimraf.sync(`./${testId}`);
});
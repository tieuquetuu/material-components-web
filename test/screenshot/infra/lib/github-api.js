/**
 * @license
 * Copyright 2018 Google Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const VError = require('verror');
const debounce = require('debounce');
const octokit = require('@octokit/rest');

const Analytics = require('./analytics');
const GitRepo = require('./git-repo');
const getStackTrace = require('./stacktrace')('GitHubApi');

class GitHubApi {
  constructor() {
    this.analytics_ = new Analytics();
    this.gitRepo_ = new GitRepo();
    this.octokit_ = octokit();
    this.isTravis_ = process.env.TRAVIS === 'true';
    this.isAuthenticated_ = false;
    this.authenticate_();
    this.initStatusThrottle_();
  }

  /** @private */
  authenticate_() {
    let token;

    try {
      token = require('../auth/github.json').api_key.personal_access_token;
    } catch (err) {
      // Not running on Travis
      return;
    }

    this.octokit_.authenticate({
      type: 'oauth',
      token: token,
    });

    this.isAuthenticated_ = true;
  }

  /** @private */
  initStatusThrottle_() {
    const throttle = (fn, delay) => {
      let lastCall = 0;
      return (...args) => {
        const now = (new Date).getTime();
        if (now - lastCall < delay) {
          return;
        }
        lastCall = now;
        return fn(...args);
      };
    };

    const createStatusDebounced = debounce((...args) => {
      return this.createStatusUnthrottled_(...args);
    }, 2500);
    const createStatusThrottled = throttle((...args) => {
      return this.createStatusUnthrottled_(...args);
    }, 5000);
    this.createStatusThrottled_ = (...args) => {
      createStatusDebounced(...args);
      createStatusThrottled(...args);
    };
  }

  /**
   * @return {{PENDING: string, SUCCESS: string, FAILURE: string, ERROR: string}}
   * @constructor
   */
  static get PullRequestState() {
    return {
      PENDING: 'pending',
      SUCCESS: 'success',
      FAILURE: 'failure',
      ERROR: 'error',
    };
  }

  /**
   * @param {string} state
   * @param {string} description
   * @param {string} targetUrl
   */
  setPullRequestStatusManual({state, description, targetUrl}) {
    if (!this.isTravis_ || !this.isAuthenticated_) {
      return;
    }

    this.createStatusThrottled_({
      state,
      targetUrl,
      description,
    });
  }

  async setPullRequestError() {
    if (!this.isTravis_ || !this.isAuthenticated_) {
      return;
    }

    return await this.createStatusUnthrottled_({
      state: GitHubApi.PullRequestState.ERROR,
      targetUrl: `https://travis-ci.com/material-components/material-components-web/jobs/${process.env.TRAVIS_JOB_ID}`,
      description: 'Error running screenshot tests',
    });
  }

  /**
   * @param {string} state
   * @param {string} targetUrl
   * @param {string=} description
   * @return {!Promise<*>}
   * @private
   */
  async createStatusUnthrottled_({state, targetUrl, description = undefined}) {
    if (!this.isAuthenticated_) {
      return null;
    }

    const travisPrSha = process.env.TRAVIS_PULL_REQUEST_SHA;
    const travisCommit = process.env.TRAVIS_COMMIT;
    const travisPrBranch = process.env.TRAVIS_PULL_REQUEST_BRANCH;
    const travisBranch = process.env.TRAVIS_BRANCH;
    const sha = travisPrSha || travisCommit || await this.gitRepo_.getFullCommitHash();
    const branch = travisPrBranch || travisBranch || await this.gitRepo_.getBranchName();

    /*
    TRAVIS_BUILD_ID
    TRAVIS_BUILD_NUMBER
    TRAVIS_JOB_ID
    TRAVIS_JOB_NUMBER
    TRAVIS_PULL_REQUEST
    */

    await this.storeGCP_({state, targetUrl, description, sha, branch});

    let stackTrace;

    try {
      stackTrace = getStackTrace('createStatusUnthrottled_');
      return await this.octokit_.repos.createStatus({
        owner: 'material-components',
        repo: 'material-components-web',
        sha,
        state,
        target_url: targetUrl,
        description,
        context: 'screenshot-test/butter-bot',
      });
    } catch (err) {
      throw new VError(err, `Failed to set commit status:\n${stackTrace}`);
    }
  }

  /**
   * @param {string=} branch
   * @return {!Promise<?number>}
   */
  async getPullRequestNumber(branch = undefined) {
    branch = branch || await this.gitRepo_.getBranchName();

    let allPrsResponse;
    let stackTrace;

    try {
      stackTrace = getStackTrace('getPullRequestNumber');
      allPrsResponse = await this.octokit_.pullRequests.getAll({
        owner: 'material-components',
        repo: 'material-components-web',
        per_page: 100,
      });
    } catch (err) {
      throw new VError(err, `Failed to get pull request number for branch "${branch}":\n${stackTrace}`);
    }

    const filteredPRs = allPrsResponse.data.filter((pr) => pr.head.ref === branch);

    const pr = filteredPRs[0];
    return pr ? pr.number : null;
  }

  /**
   * @param prNumber
   * @return {!Promise<!Array<!github.proto.PullRequestFile>>}
   */
  async getPullRequestFiles(prNumber) {
    /** @type {!github.proto.PullRequestFileResponse} */
    let fileResponse;
    let stackTrace;

    try {
      stackTrace = getStackTrace('getPullRequestFiles');
      fileResponse = await this.octokit_.pullRequests.getFiles({
        owner: 'material-components',
        repo: 'material-components-web',
        number: prNumber,
        per_page: 300,
      });
    } catch (err) {
      throw new VError(err, `Failed to get file list for PR #${prNumber}:\n${stackTrace}`);
    }

    return fileResponse.data;
  }

  /**
   * @param {number} prNumber
   * @return {!Promise<string>}
   */
  async getPullRequestBaseBranch(prNumber) {
    let prResponse;
    let stackTrace;

    try {
      stackTrace = getStackTrace('getPullRequestBaseBranch');
      prResponse = await this.octokit_.pullRequests.get({
        owner: 'material-components',
        repo: 'material-components-web',
        number: prNumber,
      });
    } catch (err) {
      throw new VError(err, `Failed to get the base branch for PR #${prNumber}:\n${stackTrace}`);
    }

    if (!prResponse.data) {
      const serialized = JSON.stringify(prResponse, null, 2);
      throw new Error(`Unable to fetch data for GitHub PR #${prNumber}:\n${serialized}`);
    }

    return `origin/${prResponse.data.base.ref}`;
  }

  /**
   * @param {number} prNumber
   * @param {string} comment
   * @return {!Promise<*>}
   */
  async createPullRequestComment({prNumber, comment}) {
    if (!this.isTravis_ || !this.isAuthenticated_) {
      return;
    }

    let stackTrace;

    try {
      stackTrace = getStackTrace('createPullRequestComment');
      return await this.octokit_.issues.createComment({
        owner: 'material-components',
        repo: 'material-components-web',
        number: prNumber,
        body: comment,
      });
    } catch (err) {
      throw new VError(err, `Failed to create comment on PR #${prNumber}:\n${stackTrace}`);
    }
  }
}

module.exports = GitHubApi;

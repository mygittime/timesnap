/**
 * BSD 3-Clause License
 *
 * Copyright (c) 2018-2022, Steve Tung
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of the copyright holder nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const defaultDuration = 5;
const defaultFPS = 60;
const { overwriteRandom } = require('./lib/overwrite-random');
const { stringArrayFind, getPageViewportSize, setPageViewportSize } = require('./lib/utils');

module.exports = async function (config) {
  config = Object.assign({}, config || {});
  var url = config.url || 'index.html';
  var delayMs = 1000 * (config.start || 0);
  var startWaitMs = 1000 * (config.startDelay || 0);
  var frameNumToTime = config.frameNumToTime;
  var unrandom = config.unrandomize;
  var fps = config.fps, frameDuration;
  var framesToCapture;
  var requestStartCapture = true;
  var requestStopCapture = false;
  var outputPath = path.resolve(process.cwd(), (config.outputDirectory || './'));
  
  /*
    空跑张数
    截图开始回调前将当前marker状态改为Only Animate，正常运行程序但是不截图，同时计算张数。
    回调后在markers中插入对应张数图片
  */
  var skipMarkerCount = 0; 

  if (!url.includes('://')) {
    // assume it is a file path
    url = 'file://' + path.resolve(process.cwd(), url);
  }

  if (config.frames) {
    framesToCapture = config.frames;
    if (!fps) {
      if (config.duration) {
        fps = framesToCapture / config.duration;
      }
      else {
        fps = defaultFPS;
      }
    }
  } else {
    if (!fps) {
      fps = defaultFPS;
    }
    if (config.duration) {
      framesToCapture = config.duration * fps;
    } else {
      framesToCapture = defaultDuration * fps;
    }
  }

  frameDuration = 1000 / fps;

  if (!frameNumToTime) {
    frameNumToTime = function (frameCount) {
      return (frameCount - 1) * frameDuration;
    };
  }

  const log = function () {
    if (!config.quiet) {
      if (config.logger) {
        config.logger(...arguments);
      } else if (config.logToStdErr) {
        // eslint-disable-next-line no-console
        console.error.apply(this, arguments);
      } else {
        // eslint-disable-next-line no-console
        console.log.apply(this, arguments);
      }
    }
  };

  const launchOptions = {
    dumpio: !config.quiet && !config.logToStdErr,
    headless: (config.headless !== undefined ? config.headless : true),
    executablePath: config.executablePath,
    args: config.launchArguments || []
  };

  const getBrowser = async function (config, launchOptions) {
    if (config.browser) {
      return Promise.resolve(config.browser);
    } else if (config.launcher) {
      return Promise.resolve(config.launcher(launchOptions));
    } else if (config.remoteUrl) {
      let queryString = Object.keys(launchOptions).map(key => key + '=' + launchOptions[key]).join('&');
      let remote = config.remoteUrl + '?' + queryString;
      return puppeteer.connect({ browserWSEndpoint: remote });
    } else {
      return puppeteer.launch(launchOptions);
    }
  };
  // A marker is an action at a specific time
  var markers = [];
  var markerId = 0;
  function addMarker({time, type, data}) {
    markers.push({ time, type, data, id: markerId++ });
  }
  async function run() {
    var browser = await getBrowser(config, launchOptions);
    var page = await browser.newPage();
    config = Object.assign({
      log,
      outputPath,
      page,
      addMarker,
      framesToCapture
    }, config);
    var capturer, timeHandler;
    if (config.canvasCaptureMode) {
      if (typeof config.canvasCaptureMode === 'string' && config.canvasCaptureMode.startsWith('immediate')) {
        // remove starts of 'immediate' or 'immediate:'
        config.canvasCaptureMode = config.canvasCaptureMode.replace(/^immediate:?/, '');
        ({ timeHandler, capturer } = require('./lib/immediate-canvas-handler')(config));
        log('Capture Mode: Immediate Canvas');
      } else {
        timeHandler = require('./lib/overwrite-time');
        capturer = require('./lib/capture-canvas')(config);
        log('Capture Mode: Canvas');
      }
    } else {
      timeHandler = require('./lib/overwrite-time');
      capturer = require('./lib/capture-screenshot')(config);
      log('Capture Mode: Screenshot');
    }
    var scaleArg = stringArrayFind(launchOptions.args, '--force-device-scale-factor') ||
      stringArrayFind(launchOptions.args, '--device-scale-factor');
    if (config.viewport || scaleArg) {
      config.viewport = Object.assign(
        {
          width: getPageViewportSize(page).width,
          height: getPageViewportSize(page).height,
          deviceScaleFactor: scaleArg ? Number(scaleArg.split('=')[1]) || 1 : 1
        },
        config.viewport
      );
      await setPageViewportSize(page, config.viewport);
    }
    await overwriteRandom(page, unrandom, log);
    await timeHandler.overwriteTime(page);

    if (config.startFunctionName) {
      requestStartCapture = false;
      await page.exposeFunction(config.startFunctionName, ()=>{startCapture()})
    }
    function startCapture(){
      //开始截图回调，不需要追加截图张数
      if(skipMarkerCount == 0){
        requestStartCapture = true;
        return;
      }

      let dis = markers[2].time - markers[1].time;
      let lastMarker = markers[markers.length-1];
      let newMarkers = [];

      for(let i=1; i<=skipMarkerCount; i++){
        markers.push({
          time:lastMarker.time + dis*i,
          type:'Capture',
          data:{
            frameCount:lastMarker.data.frameCount + i
          },
          id:lastMarker.id + i
        })
      }
      requestStartCapture = true;
    }
    if (config.stopFunctionName) {
      await page.exposeFunction(config.stopFunctionName, () => requestStopCapture = true);
    }
    if (typeof config.navigatePageToURL === 'function') {
      await config.navigatePageToURL({ page, url, log });
    } else {
      log('Going to ' + url + '...');
      await page.goto(url, { waitUntil: 'networkidle0' });
    }
    log('Page loaded');
    if (timeHandler.preparePage) {
      await timeHandler.preparePage({ page, url, log });
    }
    if ('preparePage' in config) {
      log('Preparing page before screenshots...');
      await Promise.resolve(config.preparePage(page));
      log('Page prepared');
    }
    if (startWaitMs) {
      await new Promise((resolve) => {
        setTimeout(resolve, startWaitMs);
      });
    }
    var captureTimes = [];
    if (capturer.beforeCapture) {
      // run beforeCapture right before any capture frames
      addMarker({
        time: delayMs + frameNumToTime(1, framesToCapture),
        type: 'Run Function',
        data: {
          fn: function () {
            return capturer.beforeCapture(config);
          }
        }
      });
    }
    for (let i = 1; i <= framesToCapture; i++) {
      addMarker({
        time: delayMs + frameNumToTime(i, framesToCapture),
        type: 'Capture',
        data: { frameCount: i }
      });
      captureTimes.push(delayMs + frameNumToTime(i, framesToCapture));
    }

    // run 'requestAnimationFrame' early on, just in case if there
    // is initialization code inside of it
    var addAnimationGapThreshold = 100;
    var addAnimationFrameTime = 20;
    if (captureTimes.length && captureTimes[0] > addAnimationGapThreshold) {
      addMarker({
        time: addAnimationFrameTime,
        type: 'Only Animate'
      });
    }

    var lastMarkerTime = 0;
    var maximumAnimationFrameDuration = config.maximumAnimationFrameDuration;
    captureTimes.forEach(function (time) {
      if (maximumAnimationFrameDuration) {
        let frameDuration = time - lastMarkerTime;
        let framesForDuration = Math.ceil(frameDuration / maximumAnimationFrameDuration);
        for (let i = 1; i < framesForDuration; i++) {
          addMarker({
            time: lastMarkerTime + (i * frameDuration / framesForDuration),
            type: 'Only Animate',
          });
        }
      }
      lastMarkerTime = time;
    });

    markers = markers.sort(function (a, b) {
      if (a.time !== b.time) {
        return a.time - b.time;
      }
      return a.id - b.id;
    });

    var startCaptureTime = new Date().getTime();
    var markerIndex = 0;

    var intervalTime = markers[markers.length-1].time - markers[markers.length-2].time;
    while (markerIndex < markers.length && ! requestStopCapture) {
      var marker = markers[markerIndex];
      markerIndex++;
      //线程空跑不截图
      if(!requestStartCapture && marker.type == "Capture"){
        skipMarkerCount++;
        marker.type = "Only Animate";
        await new Promise(re=>{setTimeout(e=>{re()}, intervalTime)})
      }
      if (marker.type === 'Capture') {
        await timeHandler.goToTimeAndAnimateForCapture(page, marker.time);
        var skipCurrentFrame;
        if (config.shouldSkipFrame) {
          skipCurrentFrame = await config.shouldSkipFrame({
            page: page,
            frameCount: marker.data.frameCount-skipMarkerCount,
            framesToCapture: framesToCapture
          });
        }

        if (skipCurrentFrame) {
          log('Skipping frame: ' + marker.data.frameCount);
        } else {
          if (config.preparePageForScreenshot) {
            log('Preparing page for screenshot...');
            await config.preparePageForScreenshot(page, marker.data.frameCount, framesToCapture);
            log('Page prepared');
          }
          if (capturer.capture) {
            //减去空跑张数计算图片原本的编号
            await capturer.capture(config, marker.data.frameCount-skipMarkerCount, framesToCapture);
          }
        }
      } else if (marker.type === 'Only Animate') {
        await timeHandler.goToTimeAndAnimate(page, marker.time);
      } else if (marker.type === 'Run Function') {
        await marker.data.fn(marker);
      }
    }
    log('Elapsed capture time: ' + (new Date().getTime() - startCaptureTime));
    if (capturer.afterCapture) {
      await capturer.afterCapture();
    }
    await browser.close();
  }
  try {
    await run();
  } catch (err) {
    log(err);
    throw err;
  }
};

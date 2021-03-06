/*
 ==============================================================================
 This file is part of hoast360, the open-source, higher-order Ambisonics, 360
 degree audio/video player.

 https://github.com/thomasdeppisch/hoast360

 Authors: Thomas Deppisch, Nils Meyer-Kahlen
 
 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.
 
 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.
 
 You should have received a copy of the GNU General Public License
 along with this program.  If not, see <http://www.gnu.org/licenses/>.
 ==============================================================================
 */

import * as dashjs from "dashjs";
import videojs from "video.js";
import "videojs-contrib-dash";
import "videojs-http-source-selector";
import "videojs-contrib-quality-levels";
import "videojs-xr";
import MatrixMultiplier from "./dependencies/MatrixMultiplier.js";
import {
  zoomMtx,
  stepsize,
  minZoomfactor,
  maxZoomfactor,
} from "./dependencies/HoastZoom.js";
import PlaybackEventHandler from "./dependencies/PlaybackEventHandler.js";
import HOASTloader from "./dependencies/HoastLoader.js";
import HOASTBinDecoder from "./dependencies/HoastBinauralDecoder.js";
import HOASTRotator from "./dependencies/HoastRotator.js";
import "./css/video-js.css";
import "./css/hoast360.css";
import GazeEvent from "gaze-event";
import * as THREE from "three";

("use strict");

export class HOAST360 {
  constructor() {
    this.order = 0;
    this.irs = "";
    this.mediaUrl = "";
    this.irUrl = "";
    this.audioPlayer = null;
    this.sourceNode = null;
    this.audioSetupComplete = false;
    this.videoSetupComplete = false;
    this.xrActive = false;
    this.context = null;
    this.rotator = null;
    this.multiplier = null;
    this.decoder = null;
    this.masterGain = 0;
    this.numCh = 0;
    this.videoPlayer = null;
    this.maxOrder = 4;
    this.opusSupport = true;
    this.zoomIndex = 1;
    // add gaze-event varaible here
    this.gazeEvent = null;
    // expose the scene for easy addition of gaze elements, lazy but...
    this.scene = null;

    var AudioContext = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContext();
    console.log(this.context);

    this.playbackEventHandler = new PlaybackEventHandler(this.context);

    // create as many audio players as we need for max order
    this.audioElement = new Audio();
    if (this.audioElement.canPlayType('audio/ogg; codecs="opus"') === "") {
      this.opusSupport = false;
    }

    // create sourceNodes and connect to splitters as we cannot disconnect and reuse these
    // (error: HTMLMediaElement already connected ...)
    this.sourceNode = this.context.createMediaElementSource(this.audioElement);
    this.videoPlayer = videojs("hoast360-player", {
      html5: { nativeCaptions: false },
      liveui: true,
      plugins: {
        httpSourceSelector: { default: "auto" },
      },
    });
  }

  initialize(newMediaUrl, newIrUrl, newOrder) {
    if (!this.opusSupport) {
      this.videoPlayer.error(
        "Error: Your browser does not support the OPUS audio codec. Please use Firefox or Chrome-based browsers."
      );
      return;
    }

    this.videoPlayer.xr();
    console.log(this.videoPlayer);
    console.log(this.videoPlayer.xr());

    this.audioSetupComplete = false;
    this.videoSetupComplete = false;

    if (this.order > this.maxOrder)
      console.error("Ambisonic orders greater than 4 not supported!");

    this.order = newOrder;
    this.mediaUrl = newMediaUrl;
    this.irUrl = newIrUrl;
    this._setOrderDependentVariables();

    this.videoPlayer.src({
      type: "application/dash+xml",
      src: this.mediaUrl + "video.mpd",
    });

    this.audioPlayer = dashjs.MediaPlayer().create();
    this.audioPlayer.initialize(this.audioElement);
    this.audioPlayer.setAutoPlay(false);
    this.audioPlayer.attachSource(this.mediaUrl + "audio.mpd");
    let scope = this;

    this.videoPlayer.xr().on("initialized", function () {
      console.log("xr initialized");
      scope._startSetup();
      scope.playbackEventHandler.initialize(
        scope.videoPlayer,
        scope.audioPlayer
      );
    });
  }

  reset() {
    if (!this.opusSupport) {
      this.videoPlayer.reset();
      return;
    }

    this.playbackEventHandler.reset();
    this.videoPlayer.pause();
    this._disconnectAudio();
    this.videoPlayer.xr().reset();
    this.videoPlayer.dash.mediaPlayer.reset();
    this.videoPlayer.reset(); // this triggers an error "failed to remove source buffer from media source", but seems to work anyway
    this.audioPlayer.reset();
  }

  testFunction() {
    console.log("test message: " + this);
  }

  makeGazeTarget() {
    // create a cube
    var geometry = new THREE.CubeGeometry(2, 2, 2);
    var material = new THREE.MeshLambertMaterial({
      color: 0xef6500,
    //   needsUpdate: true,
      opacity: 1,
      transparent: true,
    });
    var cube = new THREE.Mesh(geometry, material);
    cube.castShadow = true;
    cube.position.set(
      100 * Math.random() - 50,
      50 * Math.random() - 10,
      100 * Math.random() - 50
    );
    this.scene.add(cube);
    // add eventlistener for each cube
    this.gazeEvent.on(cube, "gazeEnter", function (target) {
      // gazeEnter emit
      target.material.opacity = 0.5;
    });
    this.gazeEvent.on(cube, "gazeTrigger", function (target) {
      // gazeTrigger emit in each animation frame
      target.rotation.y += 0.02;
    });
    this.gazeEvent.on(cube, "gazeLeave", function (target) {
      // gazeLeave emit
      target.material.opacity = 1;
    });
  }

  _disconnectAudio() {
    this.sourceNode.disconnect();
    this.rotator.out.disconnect();
    this.multiplier.out.disconnect();
    this.decoder.out.disconnect();
    this.masterGain.disconnect();
  }

  _startSetup() {
    if (!this.audioSetupComplete && !this.videoSetupComplete) {
      this._setupAudio();
      this._setupVideo();
      // build gaze events here
      this._setupGaze();
    }
  }

  _setupAudio() {
    let scope = this;

    // initialize ambisonic rotator
    this.rotator = new HOASTRotator(this.context, this.order);
    console.log(this.rotator);

    // initialize matrix multiplier (for now use always 4th order as zoom matrix is in 4th order format)
    this.multiplier = new MatrixMultiplier(this.context, 4);
    console.log(this.multiplier);

    this.decoder = new HOASTBinDecoder(this.context, this.order);
    console.log(this.decoder);

    var loader_filters = new HOASTloader(
      this.context,
      this.order,
      this.irs,
      (foaBuffer, hoaBuffer) => {
        this.decoder.updateFilters(foaBuffer, hoaBuffer);
        this.playbackEventHandler.setAllBuffersLoaded(true);
      }
    );
    loader_filters.load();

    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = 1.0;

    this.videoPlayer.on("volumechange", function () {
      if (!scope.masterGain) return;

      if (this.muted()) scope.masterGain.gain.value = 0;
      else scope.masterGain.gain.value = this.volume();
    });

    this.sourceNode.channelCount = this.numCh;

    this.sourceNode.connect(this.rotator.in);
    this.rotator.out.connect(this.multiplier.in);
    this.multiplier.out.connect(this.decoder.in);
    this.decoder.out.connect(this.masterGain);
    this.masterGain.connect(this.context.destination);

    this.audioSetupComplete = true;
  }

  _setupVideo() {
    this.videoPlayer.xr().camera.rotation.order = "YZX"; // in THREE Y is vertical axis! -> set to yaw-pitch-roll
    let vidControls = this.videoPlayer.xr().controls3d;
    vidControls.orbit.minDistance = -700;
    vidControls.orbit.maxDistance = 200;

    let scope = this;
    // this.controls3d.orbit.on( .. ) does not work for custom events!
    // view change
    vidControls.orbit.addEventListener("change", function () {
      if (scope.xrActive) return;

      scope.rotator.updateRotationFromCamera(
        scope.videoPlayer.xr().camera.matrixWorld.elements
      );
    });

    // view change if HMD is used
    this.videoPlayer.xr().on("xrCameraUpdate", function () {
      if (!scope.xrActive) return;

      scope.rotator.updateRotationFromCamera(
        this.xrPose.views[0].transform.matrix
      );
    });

    vidControls.orbit.addEventListener("zoom", function () {
      // zoom change
      scope._updateZoom();
    });

    this.videoPlayer.xr().on("xrSessionActivated", function () {
      scope.xrActive = true;
      scope.multiplier.bypass(true);
    });

    this.videoPlayer.xr().on("xrSessionDeactivated", function () {
      scope.xrActive = false;
      scope.multiplier.bypass(false);
      scope._updateZoom();
      scope.rotator.updateRotationFromCamera(this.camera.matrixWorld.elements);
    });

    this.videoSetupComplete = true;
  }

  _setupGaze() {
    let scope = this;
    scope.scene = scope.videoPlayer.xr().scene;
    let vidControls = scope.videoPlayer.xr().controls3d;
    let camera = scope.videoPlayer.xr().camera;
    camera.position.set(0,0,0);
    // init gazeEvent
    scope.gazeEvent = new GazeEvent();
    
    // disable the zoom controls, it interferes with gaze target positions.
    vidControls.orbit.enableZoom = false;

    vidControls.orbit.addEventListener("change", function () {
      if (scope.xrActive) return;

      scope.gazeEvent.update(camera);
    });

    // view change if HMD is used
    this.videoPlayer.xr().on("xrCameraUpdate", function () {
      if (!scope.xrActive) return;

      scope.gazeEvent.update(camera);
    });
    console.log("gaze setup complete");
  }

  _updateZoom() {
    let currentDistance = this.videoPlayer.xr().controls3d.orbit
      .currentDistance;
    let minDistance = this.videoPlayer.xr().controls3d.orbit.minDistance;

    let zoomFactor = (minDistance + currentDistance) / minDistance;
    if (zoomFactor >= minZoomfactor && zoomFactor <= maxZoomfactor) {
      let newZoomIndex = Math.round((zoomFactor - minZoomfactor) / stepsize);
      if (newZoomIndex != this.zoomIndex) {
        this.multiplier.updateMtx(zoomMtx[newZoomIndex]);
        this.zoomIndex = newZoomIndex;
      }
    }
  }

  _setOrderDependentVariables() {
    let getUrl = window.location;
    let base_url = getUrl.protocol + "//" + getUrl.host + "/";
    this.numCh = (this.order + 1) * (this.order + 1);

    if (this.irUrl.includes("://"))
      // protocol already included
      this.irs = this.irUrl + "hoast_o" + this.order + ".wav";
    else this.irs = base_url + this.irUrl + "hoast_o" + this.order + ".wav";
  }
}

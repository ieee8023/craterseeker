// simulator.js
// requires geplugin-helpers.js

/*
Copyright 2008 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * @fileoverview This is the main file for the DDSimulator class, which
 * simulates a drive over a given path in a Google Earth plugin instance
 * @author Roman Nurik
 * @supported Tested in IE6+ and FF2+
 */

/**
 * The absolute URL of the car model. Thanks to 'Glenn Quagmire (Phattius
 * Maximus's Idol!!)' for contributing the low-poly Smart car model through
 * 3D Warehouse.
 * 
 * Original URL: http://sketchup.google.com/3dwarehouse/details?mid=e515b549a0c34881da447cc46b6a15fa&prevstart=0
 * @type {string}
 */
DDSimulator.MODEL_URL = 'http://earth-api-samples.googlecode.com/svn/trunk/' +
                        'demos/drive-simulator/smart.kmz';

/**
 * The amount of real time to simulate per simulator tick
 * @type {number}
 */
DDSimulator.TICK_SIM_MS = 66;

/**
 * Total real time elapsed in the simulation, in seconds
 * @type {number}
 */
DDSimulator.prototype.totalTime = 0;

/**
 * Total distance traveled in the simulation, in meters
 * @type {number}
 */
DDSimulator.prototype.totalDistance = 0;

/**
 * Current traveling speed in the simulation, in meters per second
 * @type {number}
 */
DDSimulator.prototype.currentSpeed = 0;

/**
 * Current location of the car in the simulation
 * @type {google.maps.LatLng}
 */
DDSimulator.prototype.currentLoc = null;

/**
 * Constructs a simulator object
 * @param {Object} ge The Google Earth instance
 * @param {Array.<Object>} path The path to simulate, as an array of vertex
 *     objects of the form:
 *   {google.maps.LatLng} loc The vertex location of vertex,
 *   {number} step The index of the associated directions step
 *   {number} duration The time duration before the next vertex, in seconds
 *   {number} distance The distance to the next vertex, in meters
 * @param {Object?} opt_opts An object with the following optional fields:
 *   {Function?} on_tick A callback function, called after one tick of the
 *       simulation completes
 *   {Function?} on_changeStep A callback function for when the current step
 *       changes (as per the step property of path items)
 *   {number} speed A multiplier on the simulation speed
 * @constructor
 */
function DDSimulator(ge, path, opt_opts) {
  this.ge = ge;
  this.path = path;
  this.options = opt_opts || {};
  if (!this.options.speed)
    this.options.speed = 1.0;
  
  this.currentLoc = this.path[0].loc;
  
  // private vars
  this.geHelpers_ = new GEHelpers(ge);
  this.doTick_ = false;
  this.pathIndex_ = 0;
  this.currentStep_ = -1;
  this.segmentTime_ = 0;
  this.segmentDistance_ = 0;
}

/**
 * Initializes the simulator UI
 * @param {Function?} opt_cb Optional callback
 */
DDSimulator.prototype.initUI = function(opt_cb) {
  var me = this;
  window.google.earth.fetchKml(
      this.ge,
      DDSimulator.MODEL_URL,
      function(obj) {
        me.finishInitUI_(obj, opt_cb);
      });
}

/**
 * Completes the UI initialization (i.e. once the car model is loaded); called
 * after fetchKml() is called on the car model URL
 * @private
 * @param {Object} kml The car model KML object
 * @param {Function?} opt_cb Optional callback
 */
DDSimulator.prototype.finishInitUI_ = function(kml, opt_cb) {
  if (!kml ||
      !kml.getFeatures().getChildNodes().getLength()) {
    throw new Error('Error loading Model KML. Expected Document > Placemark > Model.');
  }
  
  this.modelPlacemark = kml.getFeatures().getFirstChild();
  if (!('getGeometry' in this.modelPlacemark) ||
      this.modelPlacemark.getGeometry().getType() != 'KmlModel') {
    throw new Error('Error loading Model KML. Expected Document > Placemark > Model.');
  }
  
  this.model = this.modelPlacemark.getGeometry();
  this.model.setAltitudeMode(this.ge.ALTITUDE_RELATIVE_TO_GROUND);
  
  this.ge.getFeatures().appendChild(this.modelPlacemark);
  
  this.drive_(this.path[0].loc,
      this.geHelpers_.getHeading(this.path[0].loc, this.path[1].loc));
  
  var me = this;
  this.tickListener = function() {
                        if (me.doTick_)
                          me.tick_();
                      };
  
  window.google.earth.addEventListener(this.ge, 'frameend', this.tickListener);

  if (opt_cb) opt_cb();
}

/**
 * Destroy the UI and detach from the Earth instance
 */
DDSimulator.prototype.destroy = function() {
  this.stop();
  this.ge.getFeatures().removeChild(this.modelPlacemark);
  window.google.earth.removeEventListener(this.ge, 'frameend',
                                          this.tickListener);
}

/**
 * Start/resume the simulation clock
 */
DDSimulator.prototype.start = function() {
  if (this.doTick_)
    return;
  
  this.oldFlyToSpeed = this.ge.getOptions().getFlyToSpeed();
  this.ge.getOptions().setFlyToSpeed(this.ge.SPEED_TELEPORT);
  
  this.doTick_ = true;
  this.tick_();
}

/**
 * Stop/pause the simulation clock
 */
DDSimulator.prototype.stop = function() {
  if (!this.doTick_)
    return;
  
  this.ge.getOptions().setFlyToSpeed(this.oldFlyToSpeed);
  
  this.doTick_ = false;
}

/**
 * Position the car model and make it look like it's driving towards a given
 * location
 * @private
 * @param {google.maps.LatLng} loc Location to move the car to
 * @param {number} heading The direction the car should be facing
 */
DDSimulator.prototype.drive_ = function(loc, heading) {
  this.model.getLocation().setLatLngAlt(loc.lat(), loc.lng(), 0);
  
  this.model.getOrientation().setHeading(heading);
  this.moveToPointDriving_(loc, heading);
}

/**
 * Returns whether to turn left (-1) or right (1) to transition from a given
 * heading/bearing to another
 * @private
 * @param {number} heading1 Current heading/bearing, in degrees
 * @param {number} heading2 Desired heading/bearing, in degrees
 */
DDSimulator.prototype.getTurnToDirection_ = function(heading1, heading2) {
  if (Math.abs((heading1) - (heading2)) < 1)
    return heading2 - heading1;
  
  return (this.geHelpers_.fixAngle(heading2 - heading1) < 0) ? -1 : 1;
}

/**
 * Position the camera at the given location, slowly turning to eventually face
 * locFacing and zoom to an appropriate level for the current speed
 * @private
 * @param {google.maps.LatLng} loc Move to location
 * @param {number} heading Direction to face
 */
DDSimulator.prototype.moveToPointDriving_ = function(loc, heading) {
  var oldLa = this.ge.getView().copyAsLookAt(
      this.ge.ALTITUDE_RELATIVE_TO_GROUND);
  var curHeading = oldLa.getHeading();
  var desiredHeading = heading;
  
  var curRange = oldLa.getRange();
  var desiredRange = Math.max(20.0, this.currentSpeed * 10);
  
  var la = this.ge.createLookAt('');
  la.set(loc.lat(), loc.lng(),
      0, // altitude
      this.ge.ALTITUDE_RELATIVE_TO_GROUND,
      curHeading + this.getTurnToDirection_(curHeading, desiredHeading),
      60, // tilt
      curRange + (desiredRange - curRange) * 0.1 // range (inverse of zoom)
      );
  this.ge.getView().setAbstractView(la);
}


/**
 * Simulate one unit of time, as specified by TICK_SIM_MS
 * @private
 */
DDSimulator.prototype.tick_ = function() {
  if (this.pathIndex_ >= this.path.length - 1) {
    this.doTick_ = false;
    return;
  }
  
  // update current route step and run callback
  if (this.path[this.pathIndex_].step != this.currentStep_) {
    this.currentStep_ = this.path[this.pathIndex_].step;
    if (this.options.on_changeStep)
      this.options.on_changeStep(this.currentStep_);
  }
  
  // move up TICK_SIM_MS milliseconds
  this.totalTime += DDSimulator.TICK_SIM_MS * this.options.speed / 1000.0;
  this.segmentTime_ += DDSimulator.TICK_SIM_MS * this.options.speed / 1000.0;
  
  var segmentDuration = this.path[this.pathIndex_].duration;
  
  if (!this.beforeSegmentDistance_)
    this.beforeSegmentDistance_ = 0.0;
  
  // move to next segment if we pass it in this tick
  while (this.pathIndex_ < this.path.length - 1 &&
    this.segmentTime_ >= segmentDuration) {
    this.segmentTime_ -= segmentDuration;
    
    // adjust distances
    this.beforeSegmentDistance_ += this.path[this.pathIndex_].distance;
    this.segmentDistance_ = 0;
    
    // update new position in path array
    this.pathIndex_++;
    
    // bugfix thanks to naeeem, markw65:
    segmentDuration = this.path[this.pathIndex_].duration;
  }
  
  // bugfix thanks to markw65
  if (segmentDuration) {
    this.segmentDistance_ = this.path[this.pathIndex_].distance *
                            Math.min(1.0, this.segmentTime_ / segmentDuration);
    this.currentSpeed = this.path[this.pathIndex_].distance / segmentDuration;
  } else {
    this.segmentDistance_ = 0.0;
    this.currentSpeed = 0.0;
  }
  
  this.totalDistance = this.beforeSegmentDistance_ + this.segmentDistance_;
  
  if (this.pathIndex_ >= this.path.length - 1) {
    this.doTick_ = false;
    return;
  }
  
  // update the current location
  this.currentLoc = this.geHelpers_.interpolateLoc(
      this.path[this.pathIndex_].loc,
      this.path[this.pathIndex_ + 1].loc,
      this.segmentTime_ / this.path[this.pathIndex_].duration);
  this.drive_(this.currentLoc,
      this.geHelpers_.getHeading(this.path[this.pathIndex_].loc,
                                 this.path[this.pathIndex_ + 1].loc));
  
  // fire the callback if one is provided
  if (this.options.on_tick)
    this.options.on_tick();
}

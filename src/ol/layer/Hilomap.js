/**
 * @module ol/layer/Hilomap
 * A variation of Heatmap that highlights the low and high extremes.
 * API is the same as Heatmap, but the gradient should be [low, ..., neutral, ..., high] colors.
 * Author: Yan Liu https://github.com/yanliu
 * Date: 02/10/2020
 */
import {listen} from '../events.js';
import {getChangeEventType} from '../Object.js';
import {createCanvasContext2D} from '../dom.js';
import VectorLayer from './Vector.js';
import {clamp} from '../math.js';
import {assign} from '../obj.js';
import RenderEventType from '../render/EventType.js';
import Icon from '../style/Icon.js';
import Style from '../style/Style.js';
import {transform2D} from '../geom/flat/transform.js';


/**
 * @typedef {Object} Options
 * @property {number} [opacity=1] Opacity (0, 1).
 * @property {boolean} [visible=true] Visibility.
 * @property {import("../extent.js").Extent} [extent] The bounding extent for layer rendering.  The layer will not be
 * rendered outside of this extent.
 * @property {number} [zIndex] The z-index for layer rendering.  At rendering time, the layers
 * will be ordered, first by Z-index and then by position. When `undefined`, a `zIndex` of 0 is assumed
 * for layers that are added to the map's `layers` collection, or `Infinity` when the layer's `setMap()`
 * method was used.
 * @property {number} [minResolution] The minimum resolution (inclusive) at which this layer will be
 * visible.
 * @property {number} [maxResolution] The maximum resolution (exclusive) below which this layer will
 * be visible.
 * @property {Array<string>} [gradient=['#00f', '#0ff', '#0f0', '#ff0', '#f00']] The color gradient
 * of the heatmap, specified as an array of CSS color strings.
 * @property {number} [radius=8] Radius size in pixels.
 * @property {number} [blur=15] Blur size in pixels.
 * @property {number} [shadow=250] Shadow size in pixels.
 * @property {string|function(import("../Feature.js").default):number} [weight='weight'] The feature
 * attribute to use for the weight or a function that returns a weight from a feature. Weight values
 * should range from 0 to 1 (and values outside will be clamped to that range).
 * @property {import("./VectorRenderType.js").default|string} [renderMode='vector'] Render mode for vector layers:
 *  * `'image'`: Vector layers are rendered as images. Great performance, but point symbols and
 *    texts are always rotated with the view and pixels are scaled during zoom animations.
 *  * `'vector'`: Vector layers are rendered as vectors. Most accurate rendering even during
 *    animations, but slower performance.
 * @property {import("../source/Vector.js").default} [source] Source.
 */


/**
 * @enum {string}
 * @private
 */
const Property = {
  BLUR: 'blur',
  GRADIENT: 'gradient',
  RADIUS: 'radius'
};


/**
 * @const
 * @type {Array<string>}
 */
//const DEFAULT_GRADIENT = ['#00f', '#0ff', '#0f0', '#ff0', '#f00'];
const DEFAULT_GRADIENT = ['#b1182b', '#d6604d', '#f3a481', '#fddbc7', '#f6f7f7', '#d1e5f0', '#90c4dd', '#4393c3', '#2065ab'];
//const DEFAULT_GRADIENT = [['#f7f6f6', '#fddbc7', '#f3a481', '#d6604d', '#b1182b'], ['#f6f7f7', '#d1e5f0', '#90c4dd', '#4393c3', '#2065ab']];


/**
 * @classdesc
 * Layer for rendering vector data as a heatmap.
 * Note that any property set in the options is set as a {@link module:ol/Object~BaseObject}
 * property on the layer object; for example, setting `title: 'My Title'` in the
 * options means that `title` is observable, and has get/set accessors.
 *
 * @fires import("../render/Event.js").RenderEvent
 * @api
 */
class Hilomap extends VectorLayer {
  /**
   * @param {Options=} opt_options Options.
   */
  constructor(opt_options) {
    const options = opt_options ? opt_options : {};

    const baseOptions = assign({}, options);

    delete baseOptions.gradient;
    delete baseOptions.radius;
    delete baseOptions.blur;
    delete baseOptions.shadow;
    delete baseOptions.weight;
    super(baseOptions);

    /**
     * @private
     * @type {Uint8ClampedArray}
     */
    this.gradient_ = null;
    //this.gradient_ = [null, null];

    /**
     * @private
     * @type {number}
     */
    this.shadow_ = options.shadow !== undefined ? options.shadow : 250;

    /**
     * @private
     * @type {string|undefined}
     */
    this.circleImage_ = undefined;

    /**
     * @private
     * @type {Array<Array<import("../style/Style.js").default>>}
     */
    //this.styleCache_ = null;

    listen(this,
      getChangeEventType(Property.GRADIENT),
      this.handleGradientChanged_, this);

    this.setGradient(options.gradient ? options.gradient : DEFAULT_GRADIENT);

    this.setBlur(options.blur !== undefined ? options.blur : 5);

    this.setRadius(options.radius !== undefined ? options.radius : 5);

    listen(this,
      getChangeEventType(Property.BLUR),
      this.handleStyleChanged_, this);
    listen(this,
      getChangeEventType(Property.RADIUS),
      this.handleStyleChanged_, this);

    this.handleStyleChanged_();

    const weight = options.weight ? options.weight : 'weight';
    let weightFunction;
    if (typeof weight === 'string') {
      weightFunction = function(feature) {
        return feature.get(weight);
      };
    } else {
      weightFunction = weight;
    }

    this.weight_ = weightFunction.bind(this);

    this.baseResolution_ = undefined;

    /*
    this.setStyle(function(feature, resolution) {
      const weight = weightFunction(feature);
      const opacity = weight !== undefined ? clamp(weight, 0, 1) : 1;
      // cast to 8 bits
      const index = (255 * opacity) | 0;
      let style = this.styleCache_[index];
      if (!style) {
        style = [
          new Style({
            image: new Icon({
              opacity: opacity,
              src: this.circleImage_.canvas.toDataURL()
            })
          })
        ];
        this.styleCache_[index] = style;
      }
      return style;
    }.bind(this));
    */

    // For performance reasons, don't sort the features before rendering.
    // The render order is not relevant for a heatmap representation.
    this.setRenderOrder(null);

    listen(this, RenderEventType.RENDER, this.handleRender_, this);
  }

  /**
   * @return {string} Data URL for a circle.
   * @private
   */
  createCircle_(scaleRatio) {
    const radius = this.getRadius() * scaleRatio;
    const blur = this.getBlur() * scaleRatio;
    const halfSize = (radius + blur + 1);
    const size = 2 * halfSize;
    const context = createCanvasContext2D(size, size);
    //context.shadowOffsetX = context.shadowOffsetY = this.shadow_;
    context.shadowOffsetX = context.shadowOffsetY = size;
    context.shadowBlur = blur;
    context.shadowColor = '#000';
    context.beginPath();
    //const center = halfSize - this.shadow_;
    const center = -1 * halfSize;
    context.arc(center, center, radius, 0, Math.PI * 2, true);
    context.closePath();
    context.fill();
    //return context.canvas.toDataURL();
    //return context.canvas;
    return context;
  }

  /**
   * Return the blur size in pixels.
   * @return {number} Blur size in pixels.
   * @api
   * @observable
   */
  getBlur() {
    return /** @type {number} */ (this.get(Property.BLUR));
  }

  /**
   * Return the gradient colors as array of strings.
   * @return {Array<string>} Colors.
   * @api
   * @observable
   */
  getGradient() {
    return /** @type {Array<string>} */ (this.get(Property.GRADIENT));
  }

  /**
   * Return the size of the radius in pixels.
   * @return {number} Radius size in pixel.
   * @api
   * @observable
   */
  getRadius() {
    return /** @type {number} */ (this.get(Property.RADIUS));
  }

  /**
   * @private
   */
  handleGradientChanged_() {
    const gradients = this.getGradient();
    this.gradient_ = createGradient(gradients);
    //this.gradient_[0] = createGradient(gradients[0]);
    //this.gradient_[1] = createGradient(gradients[1]);
  }

  /**
   * @private
   */
  handleStyleChanged_() {
    this.circleImage_ = this.createCircle_(1);
    //this.styleCache_ = new Array(256);
    this.changed();
  }

  /**
   * @param {import("../render/Event.js").default} event Post compose event
   * @private
   */
  handleRender_(event) {
    /*
    // check circle image: dbg
    const circleImage_ = this.circleImage_;
    const pcwidth = circleImage_.canvas.width;
    const pcheight = circleImage_.canvas.height;
    const pimg = circleImage_.getImageData(0, 0, pcwidth, pcheight).data;
    let nonz=0, max=0, sum=0;
    for (let i=0, len=pimg.length; i<len; i+=4) {
      let o = pimg[i+3];
      if (o) {
        nonz ++;
        if (o>max) {
          max = o;
        }
        sum += o;
      }
    }
    console.log('circleImage stat: ' + nonz + ' ' + max + ' ' + sum);
    */
    const context = event.context;
    const canvas = context.canvas;

    // get feature data from layer
    const frameState = event.frameState;
    // get geotransform info
    const viewState = frameState.viewState;
    const framebb = frameState.extent;
    const pixelRatio = frameState.pixelRatio;

    // bc of pixelRatio, we have create circle image dynamically anyways.
    // so let's handle zoom in/out here, too. 
    // zooming is view event, not suitable to catch at layer level processing
    // bc when a layer is created, there might not exist a view/map.
    const newResolution = viewState.resolution;
    if (this.baseResolution_ === undefined) {
      this.baseResolution_ = newResolution; // initial value as baseline
    }
    let zoomRatio = 1;
    if (Math.abs(newResolution - this.baseResolution_) > 0.00001) {
      zoomRatio = this.baseResolution_ * 1.0 / newResolution;
    }

    //console.time('T create circle shape img');

    // create point shape image
    const circleImage_ = this.createCircle_(pixelRatio * zoomRatio);

    //console.timeEnd('T create circle shape img');
    //console.time('T interpolate sparse grid');

    let pointset = [];
    let numPointsInExtent = 0;
    // coarsen grid to have cell size = radius/2
    const radius = (this.getRadius() + this.getBlur() + 1) * pixelRatio * zoomRatio;
    let cellSize = Math.round(radius / 2);
    cellSize = (cellSize == 0) ? 1 : cellSize;

    const layers = frameState.layerStatesArray;
    let layer;
    for (let ii = 0; ii < layers.length; ii++) {
      //if (layers[i].layer instanceof ol.layer.Hilomap) {
      //  layer = layers[i].layer;
      //}
      if ((layers[ii].layer instanceof Hilomap) && layers[ii].layer.getVisible()) {
        // TODO: multiple Hilomap layers
        layer = layers[ii].layer;
        break;
      }
    }
    if (layer === undefined) {
      return;
    }
    const features = layer.getSource().getFeatures();
    if (features !== undefined) {
      // interpolate relevant cells on canvas from dataxyz
      let xyz = []; // sparse grid, content is xyz of the cell
      const numFeatures = features.length;
      // similar way to render points with Leaflet heatmap
      for (let i = 0; i < numFeatures; i++) {
        const feature = features[i];
        const coord = feature.getGeometry().getCoordinates();
        if (coord[0] < framebb[0] || coord[1] < framebb[1] || coord[0] > framebb[2] || coord[1] > framebb[3]) {
          continue;
        }
        const grid_coord = transform2D(coord, 0, 1, 1, frameState.coordinateToPixelTransform);
        const px = Math.round(grid_coord[0] * pixelRatio);
        const py = Math.round(grid_coord[1] * pixelRatio);
        const weight = this.weight_(feature);
        // which cell is this point in? to get cell coord on a grid of cellsize radius/2
        const cx = Math.floor(px / cellSize);
        const cy = Math.floor(py / cellSize);
        xyz[cy] = xyz[cy] || [];
        let cell = xyz[cy][cx];
        if (!cell) {
          xyz[cy][cx] = [px, py, weight];
        } else {
          // cell value is the point w/ max( |weight - 0.5| )
          if (Math.abs(weight - 0.5) > Math.abs(cell[2] - 0.5)) {
            cell[0] = px;
            cell[1] = py;
            cell[2] = weight;
          }
        }
        numPointsInExtent++;
      }
      //console.log('num of points within canvas scope: ' + numPointsInExtent);
      // get the point set to draw
      for (let i = 0, ylen = xyz.length; i < ylen; i++) {
        if (!xyz[i]) {
          continue;
        }
        for (let j = 0, xlen = xyz[i].length; j < xlen; j++) {
          const p = xyz[i][j];
          if (p) {
            pointset.push([Math.round(p[0]), Math.round(p[1]), clamp(p[2], 0, 1)]);
          }
        }
      }
      xyz = [];
    }
    //console.log('num of coarsen cells to draw: ' + pointset.length);
    //console.timeEnd('T interpolate sparse grid');
    //console.time('T draw canvas');

    // rasterize the 'points' (grid cell points, actually)
    let image = null;
    if (pointset.length > 0) {
      // draw round 1: low points using low gradient
      let hipoints = [];
      context.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0, len = pointset.length; i < len; i++) {
        const p = pointset[i];
        if (p[2] <= 0.5) {
          context.globalAlpha = (0.5 - p[2]) * 2;
          context.drawImage(circleImage_.canvas, p[0] - radius, p[1] - radius);
        } else {
          hipoints.push(p);
        }
      }
      // get pixel weights
      let loA = new Uint8ClampedArray(canvas.width * canvas.height * 4);
      const loImg = context.getImageData(0, 0, canvas.width, canvas.height).data;
      //let nLoPixels = 0;
      for (let i = 0, len = loImg.length; i < len; i += 4) {
        // opacity is weight, copy it to memory
        loA[i + 3] = loImg[i + 3];
        //if (loA[i + 3] > 0) {
        //  nLoPixels++;
        //}
      }
      //console.log('nLoPixels: ' + nLoPixels);

      // draw round 2: high points using high gradient
      context.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0, len = hipoints.length; i < len; i++) {
        const p = hipoints[i];
        context.globalAlpha = (p[2] - 0.5) * 2;
        context.drawImage(circleImage_.canvas, p[0] - radius, p[1] - radius);
      }
      // get pixel weights
      let hiA = new Uint8ClampedArray(canvas.width * canvas.height * 4);
      const hiImg = context.getImageData(0, 0, canvas.width, canvas.height).data;
      //let nHiPixels = 0;
      for (let i = 0, len = hiImg.length; i < len; i += 4) {
        // opacity is weight, copy it to memory
        hiA[i + 3] = hiImg[i + 3];
        //if (hiA[i + 3] > 0) {
        //  nHiPixels++;
        //}
      }
      //console.log('nHiPixels: ' + nHiPixels);
      // final rendering: draw coarsen grid cells
      context.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0, len = pointset.length; i < len; i++) {
        const p = pointset[i];
        context.globalAlpha = (p[2] <= 0.5) ? ((0.5 - p[2]) * 2) : ((p[2] - 0.5) * 2);
        context.drawImage(circleImage_.canvas, p[0] - radius, p[1] - radius);
      }

      hipoints = [];
      pointset = [];

      image = context.getImageData(0, 0, canvas.width, canvas.height);
      const img = image.data;
      let wMin = 255, wMax = 0;
      for (let i = 0, len = img.length; i < len; i += 4) {
        const w = clamp(Math.round(128 + (hiA[i + 3] - loA[i + 3]) / 2), 0, 255);
        if (w > wMax) {
          wMax = w;
        }
        if (w < wMin) {
          wMin = w;
        }
        const posOnGradient = w * 4;
        if (posOnGradient) {
          img[i] = this.gradient_[posOnGradient];
          img[i + 1] = this.gradient_[posOnGradient + 1];
          img[i + 2] = this.gradient_[posOnGradient + 2];
          //img[i + 3] = w;
        }
      }
      //console.log('final opacity min max: ' + wMin + ' ' + wMax);
      // scale opacity to [0, 255]
      for (let i = 0, len = img.length; i < len; i += 4) {
        img[i + 3] = Math.round((img[i + 3] - wMin) * 255.0 / (wMax - wMin));
      }
      loA = []; // empty array
      hiA = []; // empty array
    }
    //console.timeEnd('T draw canvas');
    /*
const dbg_a = [];
const dbg_r = [];
const dbg_g = [];
const dbg_b = [];
    for (let i = 0, ii = view8.length; i < ii; i += 4) {
      const wopaque = view8[i + 3];
      if (wopaque) {
const realgradient = (wopaque<128)?this.gradient_[0]:this.gradient_[1];
const alpha = (wopaque<128)?(128-wopaque)*2:(wopaque-128)*2;
const alphaoffset = alpha * 4;
view8[i] = realgradient[alphaoffset];
view8[i + 1] = realgradient[alphaoffset + 1];
view8[i + 2] = realgradient[alphaoffset + 2];
view8[i + 3] = clamp(alpha, 0, 255);
        //view8[i] = this.gradient_[alpha];
        //view8[i + 1] = this.gradient_[alpha + 1];
        //view8[i + 2] = this.gradient_[alpha + 2];
dbg_r.push(view8[i]);
dbg_g.push(view8[i+1]);
dbg_b.push(view8[i+2]);
dbg_a.push(view8[i + 3]);
      } else {
const realgradient = this.gradient_[0];
const alpha = 0;
const alphaoffset = 0;
view8[i] = realgradient[alphaoffset];
view8[i + 1] = realgradient[alphaoffset + 1];
view8[i + 2] = realgradient[alphaoffset + 2];
view8[i + 3] = 1;
      }
    }

const dbg_alen = dbg_a.length;
const dbg_rlen = dbg_r.length;
const dbg_glen = dbg_g.length;
const dbg_blen = dbg_b.length;
//console.log(dbg_alen + ' ' + dbg_rlen + ' ' + dbg_glen + ' ' + dbg_blen + ' ');
    */
    if (image) {
      context.putImageData(image, 0, 0);
    }
  }

  /**
   * Set the blur size in pixels.
   * @param {number} blur Blur size in pixels.
   * @api
   * @observable
   */
  setBlur(blur) {
    this.set(Property.BLUR, blur);
  }

  /**
   * Set the gradient colors as array of strings.
   * @param {Array<string>} colors Gradient.
   * @api
   * @observable
   */
  setGradient(colors) {
    this.set(Property.GRADIENT, colors);
  }

  /**
   * Set the size of the radius in pixels.
   * @param {number} radius Radius size in pixel.
   * @api
   * @observable
   */
  setRadius(radius) {
    this.set(Property.RADIUS, radius);
  }
}


/**
 * @param {Array<string>} colors A list of colored.
 * @return {Uint8ClampedArray} An array.
 */
function createGradient(colors) {
  const width = 1;
  const height = 256;
  const context = createCanvasContext2D(width, height);

  const gradient = context.createLinearGradient(0, 0, width, height);
  const step = 1 / (colors.length - 1);
  for (let i = 0, ii = colors.length; i < ii; ++i) {
    gradient.addColorStop(i * step, colors[i]);
  }

  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  return context.getImageData(0, 0, width, height).data;
}


export default Hilomap;

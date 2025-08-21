import { TransformOptions, Writable } from 'stream';
import { InflatingTransform } from 'inflating-transform';

/**
 * @event EventAdaptor#token
 * @type {any}
 */

/**
 * @event EventAdaptor#error
 * @type {Error}
 */

/**
 * @interface EventAdaptor
 * @fires EventAdaptor#token
 * @fires EventAdaptor#error
 *
 * If the EventAdaptor fires an `error` event, the TokenisingStream will be destroyed with
 * the emitted error.
 */
export interface EventAdaptor {
  on(event: 'token', listener: (token: any) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'token', listener: (token: any) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
}

export interface TokenisingStreamOptions extends TransformOptions {
  /**
   * The delegate to write chunks to.
   */
  delegate: Writable;

  /**
   * The event adaptor to listen to.
   */
  adaptor: EventAdaptor;
}

export class TokenisingStream extends InflatingTransform {
  static ERROR_EVENT_NAME: string;
  static TOKEN_EVENT_NAME: string;

  /**
   * @param {TokenisingStreamOptions} opts
   *
   * `readableObjectMode` is forced to be true as the stream outputs tokens (objects)
   */
  constructor(opts: TokenisingStreamOptions);
}

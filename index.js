const { InflatingTransform } = require("inflating-transform");

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

/**
 * @typedef {Object} TokenisingStreamOptions
 * @extends TransformOptions
 * @property {Writable} delegate The delegate to write chunks to.
 * @property {EventAdaptor} adaptor The event adaptor to listen to.
 */

/**
 * @typedef {Function} NodeCallback A function which takes an error or nothing (undefined).
 * @param {Error} [error] An optional error
 *
 * The Node callback pattern is a standard pattern used in streams where the first argument
 * is an error, or nothing. This pattern is used in Writable callbacks and Transform callbacks.
 */

/**
 * A `NextFunction` is a function that returns a Promise that may reject with an Error or
 * fulfill with undefined.
 *
 * @typedef {Function} NextFunction
 * @returns Promise
 * @private
 */

const CLOSE_EVENT_NAME = "close";
const ERROR_EVENT_NAME = "error";
const TOKEN_EVENT_NAME = "token";

/**
 * @private
 */
class EventCollector {
	constructor(adaptor) {
		this.adaptor = adaptor;
		this.events = [];
		this.error = null;

		/*
		 * Use functions as props so that `this` can be used correctly,
		 * and the function reference can be used to stop listening.
		 */
		this._onToken = (event) => {
			this.events.push(event);
		}

		this._onError = (err) => {
			this.stopCollecting();

			this.error = err;
		}
	}

	startCollecting() {
		this.adaptor.on(ERROR_EVENT_NAME, this._onError);
		this.adaptor.on(TOKEN_EVENT_NAME, this._onToken);
	}

	stopCollecting() {
		this.adaptor.off(TOKEN_EVENT_NAME, this._onToken);
		this.adaptor.off(ERROR_EVENT_NAME, this._onError)
	}

	clear() {
		this.events = [];
	}
}

/**
 * Promisifies a callback-accepting function to return a Promise.
 *
 * Works by taking a function that accepts a `NodeCallback` as an argument. When the callback
 * is invoked, the Promise will be settled. If the callback is invoked with an Error, the
 * Promise will be rejected with that error. Else it is fulfilled with `undefined`.
 *
 * This can be used to chain callback accepting functions together as Promises have a
 * well-defined interface for composing Promise returning functions together.
 *
 * @param {(cb: NodeCallback) => void} fn
 * @return {Promise<void>}
 * @private
 */
const promisify = (fn) =>
	new Promise((resolve, reject) => {
		fn((err) => {
			if (err) {
				reject(err)
			}
			else {
				resolve()
			}
		})
	})

const emptyHandler = () => {}

/**
 * A widespread pattern with streaming parsers is to emit events when tokens are parsed from an
 * input string. Examples include SAX libraries, parse5 (HTML), and other streaming parsers on
 * NPM. The parser is often wrapped in a `Writable` stream to allow input strings to be streamed
 * from a source and piped into the parser. For example, a file stream or an HTTP request
 * stream. The parser stream forwards events from the wrapped parser to listeners registered on
 * the stream; as streams are `EventEmitter`s.
 *
 * While the input to the parser stream respects [back-pressure][3], the token events are not
 * streamed but merely emitted synchronously, without any kind of flow control. A typical reason
 * for choosing an event-driven parser is to avoid buffering the entire output, which in
 * Javascript typically means something needs to be done with the tokens, such as streaming
 * them elsewhere. However, simply writing the events to a stream ignores the back-pressure
 * mechanism; many events could be emitted, which could overflow a downstream listener in a
 * stream flow if data is flowing slowly, with no way to limit the fire hose upstream.
 *
 * If an error occurs during parsing, the input stream needs to be destroyed to stop
 * reading more data.
 *
 * Streams provide a standard pattern in Node.js to handle back-pressure and errors. What is
 * required is to have events from a parser stream respect back-pressure in a flow.
 *
 * `TokenisingStream` is a Transform stream that decorates a Writable stream representing a
 * parser. Input to the transform is written to the delegate and events are collected.
 * `TokenisingStream` will then push each event through the stream and only acknowledge the
 * input chunk (by using the callback provided to `_transform`) after all events are pushed
 * into the Readable output buffer. If the destination stream is slower than the source stream,
 * the read and write buffers will fill and back-pressure will be applied with
 * `TokenisingStream.write` eventually returning `false`.
 *
 * The delegate Writable must be provided using the `delegate` constructor option. To make
 * `TokenisingStream` generic, an `EventAdaptor` must be provided using the `adaptor` constructor
 * option. The adaptor is responsible for collecting events from the delegate and emitting them
 * via the `token` event for collection by the stream. If an error occurs in the delegate
 * writing a chunk, the error will be passed to the `_transform` callback. If an `error` event
 * is emitted by the event adaptor, it will be passed to the `_transform` callback.
 *
 * When the `TokenisingStream` instance is closed/flushed it will end the delegate Writable.
 * As this may see more events emitted, the stream will collect and push them before closing
 * as well.
 *
 * [1]: https://nodejs.org/docs/latest-v18.x/api/stream.html#class-streamtransform
 * [2]: https://nodejs.org/docs/latest-v18.x/api/stream.html#class-streamwritable
 * [3]: https://nodejs.org/en/learn/modules/backpressuring-in-streams
 */
class TokenisingStream extends InflatingTransform {
	static ERROR_EVENT_NAME = ERROR_EVENT_NAME;
	static TOKEN_EVENT_NAME = TOKEN_EVENT_NAME;

	/**
	 * @param {TokenisingStreamOptions} opts
	 *
	 * `readableObjectMode` is forced to be true as the stream outputs tokens (objects)
	 */
	constructor(opts) {
		super(Object.assign({}, opts, {
			readableObjectMode: true,
		}));

		if (!opts.delegate) {
			throw new Error("Missing delegate option");
		}

		if (!opts.adaptor) {
			throw new Error("Missing adaptor option");
		}

		this.delegate = opts ? opts.delegate : undefined;
		this.adaptor = opts ? opts.adaptor : undefined;
		this.collector = new EventCollector(this.adaptor);

		this._listenForDelegateEvents();
	}

	/**
	 * This implementation of `_transform` assumes that the parser is synchronous. That is, when
	 * a chunk is written to the delegate, it is parsed and all events are emitted before the call
	 * to `write` returns. Most streaming parsers will be synchronous. However, if this class is
	 * used with a parser that emits events outside the call to `write`, this implementation will
	 * need to be changed.
	 */
	_transform(chunk, encoding, callback) {
		this._doWhileCollecting(() => this._writeToDelegate(chunk, encoding), callback);
	}

	_flush(callback) {
		/** @type NodeCallback */
		const done = (err) => {
			err ? callback(err) : super._flush(callback)
		}

		this._doWhileCollecting(() => this._closeDelegate(), done);
	}

	*_inflate(chunk, _) {
		for (const item of chunk) {
			yield {
				chunk: item
			}
		}
	}

	_writeToDelegate(chunk, encoding) {
		/*
		 * There is a theoretical pathological case here where the delegate never emits any tokens
		 * and the delegate write buffer overflows as we're ignoring the result from `write` and
		 * will keep on writing chunks. However, in practice this would be unlikely to occur.
		 */
		return promisify((cb) => {
			/*
			 * Some parser libraries aren't true Writables (eg: sax). They duck type the `write` and
			 * `end` methods but don't honour the callback.
			 */
			if (this.delegate.write.length < 3) {
				this.delegate.write(chunk, encoding);
				cb()
			}
			else {
				this.delegate.write(chunk, encoding, cb);
			}
		})
	}

	_closeDelegate() {
		return promisify((cb) => {
			/*
			 * Some parsing libraries aren't true Writables (eg: sax). They don't honour the same
			 * contract as Writables in that they emit different events to indicate the stream is
			 * ended. We want to listen for all of them, and act on the first event heard.
			 */
			const endEvents = [
				"end",
				"close",
				"finish"
			]

			let err;

			// if there is an error ending the delegate.
			const onError = (e) => {
				err = e
			}

			const onEndEvent = () => {
				endEvents.forEach((event) => this.delegate.off(event, onEndEvent))
				this.delegate.off(ERROR_EVENT_NAME, onError);

				cb(err);
			}

			this.delegate.on(ERROR_EVENT_NAME, onError);
			endEvents.forEach((event) => this.delegate.on(event, onEndEvent));

			this.delegate.end()
		});
	}

	/**
	 * `_doWhileCollecting` is a method which wraps an action while collecting events.
	 *
	 * This method takes care of collecting and pushing any events that are emitted from the
	 * delegate during the call the `next`
	 *
	 * @param {NextFunction} next What action to do
	 * @param {NodeCallback} done What to do when finished.
	 * @private
	 */
	_doWhileCollecting(next, done) {
		this._startCollectingTokens();

		next()
			.then(() => this._stopCollectingTokens())
			.then(() => this._pushCollectedTokens())
			.then(done, done)
	}

	/**
	 * @private
	 */
	_checkCollectorForError() {
		return this.collector.error ? Promise.reject(this.collector.error) : Promise.resolve();
	}

	_listenForDelegateEvents() {
		/*
		 * Node streams not only pass the error to the callback passed to `write`, but will also
		 * emit the error as an event. If nothing is listening, the node runtime will treat it as an
		 * uncaught error. We register an empty handler to avoid this.
		 */
		this.delegate.on(ERROR_EVENT_NAME, emptyHandler);

		// on close, remove handlers.
		this.delegate.once(CLOSE_EVENT_NAME, () => {
			this.delegate.off(ERROR_EVENT_NAME, emptyHandler)
		});
	}

	/**
	 * Pushes any collected tokens through the stream.
	 *
	 * @private
	 */
	_pushCollectedTokens() {
		return promisify((cb) => { super._transform(this._collectedTokens(), undefined, cb) })
			.then(() => this._checkCollectorForError())
	}

	/**
	 * @private
	 */
	_collectedTokens() {
		return this.collector.events;
	}

	/**
	 * @private
	 */
	_startCollectingTokens() {
		this.collector.clear();
		this.collector.startCollecting();
	}

	/**
	 * @private
	 */
	_stopCollectingTokens() {
		this.collector.stopCollecting();
	}
}

module.exports = {
	TokenisingStream
};

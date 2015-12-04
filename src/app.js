export default (function app(feast, Benchmark, OAuth, github, share, swal) {
	'use strict';

	let gid = 1;

	const GIST_TAGS = '#jsbench #jsperf';
	const STORE_SNIPPETS_KEY = 'jsbench-snippets';

	const OAUTH_PUBLIC_KEY = 'PL76R8FlKhIm2_j4NELvcpRFErg';
	const FIREBASE_ENDPOINT = 'https://jsbench.firebaseio.com/';

	const firebase = new Firebase(FIREBASE_ENDPOINT);

	/**
	 * @class UIApp
	 * @extends feast.Block
	 */
	const UIApp = feast.Block.extend(/** @lends UIApp# */{
		name: 'app',
		template: feast.parse(document.getElementById('app-template').textContent),

		defaults: {
			desc: '',
			user: github.currentUser || {},
			gist: {},
			setup: {code: ''},
			teardown: {code: ''},
			starred: false,
			running: false
		},

		events: {
			'suite:run': 'handleSuiteRun',
			'suite:save': 'handleSuiteSave',
			'snippet:add': 'handleSuiteAdd',
			'snippet:remove': 'handleSuiteRemove',
			'gist:star': 'handleStar',
			'share': 'handleShare',
			'configure': 'handleConfigure',
			'scrollTo': 'handleScrollTo'
		},

		attrChanged: {
			desc: function desc(desc) {
				document.title = (desc ? desc + ' :: ' : '') + document.title.split('::').pop().trim();
			}
		},

		_stats: [],
		_latestData: null,
		_latestUnsavedResults: null, // последний результат тестов, чтобы при save, добавить их в базу

		snippets: [],

		hasChanges: function hasChanges() {
			return JSON.stringify(this._latestData) !== JSON.stringify(this.toJSON());
		},

		didMount: function didMount() {
			// Предупреждалка
			window.onbeforeunload = () => {
				if (!this.attrs.gist.id && this.hasChanges() || this._latestUnsavedResults) {
					return 'Your changes and test results have not been saved!';
				}
			};

			// Роутинг
			window.onhashchange = () => {
				new Promise((resolve, reject) => {
					if (this.attrs.running) {
						swal({
							title: 'Are you sure?',
							type: 'warning',
							showCancelButton: true,
							confirmButtonColor: '#A5DC86',
							confirmButtonText: 'Continue',
							cancelButtonText: 'Abort'
						}, (isConfirm) => {
							if (!isConfirm) {
								this._suite.abort();
								resolve();
							} else {
								reject();
							}
						});
					} else {
						resolve();
					}
				}).then(() => {
					this.routing();
				});
			};

			this.routing().then(() => {
				document.body.className = document.body.className.replace('state-initialization', 'state-ready');
				share.init();
			});
		},

		routing: function routing() {
			const attrs = this.attrs;
			let hash = location.hash.substr(1);

			try {
				hash = decodeURIComponent(hash);
			} catch (err) {}

			if (this._prevJSONStr === hash) {
				return;
			}

			this._prevJSONStr = '';
			this._latestUnsavedResults = null;
			this.snippets = [];

			this.refs.scrollTo.style.display = 'none';

			// Сбрасываем основные аттрибуты
			this.set({
				desc: '',
				gist: {},
				setup: {code: ''},
				teardown: {code: ''},
				starred: false,
				running: false,
				results: null
			}, null, true);

			clearInterval(this._saveId);

			// Чистим статус
			Object.keys(this.refs).forEach((name) => {
				/^stat/.test(name) && (this.refs[name].innerHTML = '');
			});

			return new Promise((resolve) => {
				let restoredData;

				// Gist ID
				if (/^[a-z0-9]+$/.test(hash)) {
					if (github.currentUser) {
						this.set('user', github.currentUser);

						github.gist.checkStar(hash).then((state) => {
							this.set('starred', state);
						});
					}

					github.gist.findOne(hash).then((gist) => {
						const R_CONFIG = /\tBenchmark\.prototype\.(setup|teardown)\s*=.*?\{([\s\S]+?)\n\t};/g;
						const R_SNIPPET = /\tsuite.add.*?\{\n([\s\S]+?)\n\t\}\);/g;
						let matches;

						while ((matches = R_CONFIG.exec(gist.files['suite.js'].content))) {
							attrs[matches[1]] = {
								code: matches[2].replace(/\n\t\t/g, '\n').trim() + '\n'
							};
						}

						while ((matches = R_SNIPPET.exec(gist.files['suite.js'].content))) {
							this.snippets.push(newSnippet(matches[1].replace(/\n\t\t/g, '\n').trim() + '\n'));
						}

						this.set({
							'desc': gist.description.split(' (http')[0],
							'gist': gist
						});

						firebase.child('stats').child(gist.id).child(getGistLastRevisionId(gist)).on('value', (snapshot) => {
							const values = snapshot.val();

							values && this.setStats(Object.keys(values).map((key) => {
								return values[key];
							}));
						});
					})
						['catch'](showError)
						.then(resolve);
				} else {
					// Пробуем восстановить код из `localStorage`
					try {
						restoredData = JSON.parse(localStorage.getItem(STORE_SNIPPETS_KEY));
					} catch (err) {}

					// Или `location.hash`
					try {
						restoredData = JSON.parse(hash);
					} catch (err) {}

					try {
						attrs.desc = restoredData.desc;
						attrs.setup = restoredData.setup || {code: ''};
						attrs.teardown = restoredData.teardown || {code: ''};
						this.snippets = restoredData.snippets.map((code) => {
							return newSnippet(code);
						});
					} catch (err) {}

					resolve();
				}
			})
				['catch'](showError)
				.then(() => {
					if (!Array.isArray(this.snippets) || !this.snippets.length) {
						this.snippets = [newSnippet()];
					}

					// Используется при unload
					this._latestData = this.toJSON();
					this._prevJSONStr = JSON.stringify(this.toJSON());

					// Cохраняем в `hash` и `localStorage` раз в 1sec
					this._saveId = setInterval(() => {
						if (!attrs.gist.id) {
							const jsonStr = JSON.stringify(this.toJSON());

							if (this._prevJSONStr !== jsonStr) {
								this._prevJSONStr = jsonStr;

								try {
									// location.hash = encodeURIComponent(jsonStr);
									localStorage.setItem(STORE_SNIPPETS_KEY, jsonStr);
								} catch (err) {}
							}
						}
					}, 1000);

					this.render();
				});
		},

		setStats: function setStats(values) {
			const stats = {};

			this._stats = values;

			values.forEach((data) => {
				let stat = stats[data.name];

				if (!stat) {
					stats[data.name] = stat = [data.name].concat(data.hz);
					stat.count = 1;
				} else {
					stat.count++;
					stat[0] = data.name + ' (' + stat.count + ')';

					for (let i = 0, n = data.hz.length; i < n; i++) {
						stat[i + 1] = (data.hz[i] + stat[i + 1]) / 2;
					}
				}
			});

			this.set('results', {
				names: this.snippets.map((snippet, idx) => {
					return '#' + (idx + 1) + ': ' + getName(snippet);
				}),

				series: Object.keys(stats).map((name) => {
					return stats[name];
				})
			});
		},

		addStat: function addStat(stat) {
			if (stat) {
				const gist = this.attrs.gist;
				const data = {
					name: Benchmark.platform.name + ' ' + Benchmark.platform.version,
					hz: stat
				};

				this._latestUnsavedResults = stat;
				this._stats.push(data);
				this.setStats(this._stats);

				if (gist.id && !this.hasChanges()) {
					this._latestUnsavedResults = null;
					firebase.child('stats').child(gist.id).child(getGistLastRevisionId(gist)).push(data);
				}
			}
		},

		toJSON: function toJSON() {
			const attrs = this.attrs;

			return {
				desc: attrs.desc,
				setup: {code: attrs.setup.code},
				teardown: {code: attrs.teardown.code},
				snippets: this.snippets.map((snippet) => {
					return snippet.code;
				})
			};
		},

		handleSuiteAdd: function handleSuiteAdd() {
			this.snippets.push(newSnippet());
			this.render();
		},

		handleSuiteRemove: function handleSuiteRemove(evt) {
			this.snippets.splice(this.snippets.indexOf(evt.details), 1);
			this.render();
		},

		handleSuiteRun: function handleSuiteRun() {
			const refs = this.refs;
			const attrs = this.attrs;
			const suite = new Benchmark.Suite;
			const index = {};

			this.snippets.forEach((snippet) => {
				snippet.status = '';
				index[snippet.id] = snippet;

				suite.add(snippet.id, {
					fn: snippet.code.trim(),
					setup: attrs.setup.code,
					teardown: attrs.teardown.code,
					onCycle: function onCycle(evt) {
						refs['stats-' + snippet.id].innerHTML = toStringBench(evt.target);
					}
				});
			});

			suite
				.on('cycle', (evt) => {
					const stat = evt.target;
					// const el = refs['stats-' + stat.name];

					!suite.aborted && (refs['stats-' + stat.name].innerHTML = toStringBench(stat));
				})
				.on('complete', (evt) => {
					if (!suite.aborted) {
						const results = evt.currentTarget;

						suite.filter('fastest').forEach((stat) => {
							index[stat.name].status = 'fastest';
						});

						suite.filter('slowest').forEach((stat) => {
							index[stat.name].status = 'slowest';
						});

						this.addStat(results.map((bench) => {
							return bench.hz;
						}));

						this.set('running', false);
						this.refs.scrollTo.style.display = '';
					}
				});

			this.set('running', true);

			suite.run({'async': true});
			this._suite = suite;
		},

		handleSuiteSave: function handleSuiteSave() {
			const attrs = this.attrs;
			const gist = attrs.gist;
			const desc = (attrs.desc || 'Untitled benchmark');
			const suiteCode = [
				'"use strict";',
				'',
				'(function (factory) {',
				'	if (typeof Benchmark !== "undefined") {',
				'		factory(Benchmark);',
				'	} else {',
				'		factory(require("benchmark"));',
				'	}',
				'})(function (Benchmark) {',
				'	let suite = new Benchmark.Suite;',
				'',

				// Setup
				(!attrs.setup.code.trim() ? '' : [
					'	Benchmark.prototype.setup = function () {',
					'		' + attrs.setup.code.trim().split('\n').join('\n\t\t'),
					'	};',
					''
				].join('\n')),

				// Teardown
				(!attrs.teardown.code.trim() ? '' : [
					'	Benchmark.prototype.teardown = function () {',
					'		' + attrs.teardown.code.trim().split('\n').join('\n\t\t'),
					'	};',
					''
				].join('\n')),

				// Snippets
				this.snippets.map((snippet) => {
					return [
						'	suite.add(' + JSON.stringify(getName(snippet)) + ', function () {',
						'		' + (snippet.code || '').trim().split('\n').join('\n\t\t'),
						'	});'
					].join('\n');
				}).join('\n\n'),
				'',
				'	suite.on("cycle", function (evt) {',
				'		console.log("  " + evt);',
				'	});',
				'',
				'	suite.on("complete", function (evt) {',
				'		let results = evt.currentTarget.sort(function (a, b) {',
				'			return b.hz - a.hz;',
				'		});',
				'',
				'		results.forEach(function (item) {',
				'			console.log("  " + item);',
				'		});',
				'	});',
				'',
				'	console.log(' + JSON.stringify(desc) + ');',
				'	console.log(new Array(30).join("-"));',
				'	suite.run();',
				'});',
				''
			].join('\n');

			const files = {
				'suite.js': {content: suiteCode},
				'index.html': {content: [
					'<!DOCTYPE html>',
					'<html>',
					'<head>',
					'	<meta charset="utf-8"/>',
					'	<title>' + desc + '</title>',
					'	<script src="https://cdnjs.cloudflare.com/ajax/libs/benchmark/1.0.0/benchmark.min.js"></script>',
					'	<script src="./suite.js"></script>',
					'</head>',
					'<body>',
					'	<h1>Open the console to view the results</h1>',
					'	<h2><code>cmd + alt + j</code> or <code>ctrl + alt + j</code></h2>',
					'</body>',
					'</html>',
					''
				].join('\n')}
			};

			this.set('saving', true);

			// Запросим пользователя, чтобы быть 100% уверенными в актуальности данных
			github.user()
				.then((user) => {
					const save = (gist) => {
						const isNew = !gist.id;

						return github.gist.save(gist.id, desc + (isNew ? ' ' : ' (' + location.toString() + ') ') +
								GIST_TAGS, files).then((gist) => {
									this.set('gist', gist); // (1)
									location.hash = gist.id; // (2)

									swal('Saved', gist.html_url, 'success');

									if (isNew) {
										github.gist.save(gist.id, desc + ' (' + location.toString() + ') ' + GIST_TAGS);
										this.addStat(this._latestUnsavedResults);
									}

									return gist;
								});
					};

					// Обновляем текущего юзера
					github.setUser(user);
					this.set('user', user);

					// А теперь решим, fork или save
					return (gist.id && gist.owner.id !== user.id) ? github.gist.fork(gist.id).then(save) : save(gist);
				})
					['catch'](showError).then(() => {
						this._latestData = this.toJSON();
						this.set('saving', false);
					});
		},

		handleStar: function handleStar() {
			this.invert('starred');
			github.gist.star(this.attrs.gist.id, this.attrs.starred);
		},

		handleConfigure: function handleConfigure(evt) {
			evt.details.visible = !evt.details.visible;
			this.render();
		},

		handleScrollTo: function handleScrollTo() {
			this.refs.scrollTo.style.display = 'none';
			this.refs.chart.scrollIntoView();
		},

		handleShare: function handleShare(evt) {
			const service = evt.details;

			Promise.resolve(
				share[service](this.attrs.desc, location.toString(), GIST_TAGS, this)
			).then(() => {
				swal(service.charAt(0).toUpperCase() + service.substr(1), 'The test results is shared', 'success');
			}, showError);
		}
	});

	//
	// Вспомогательные методы
	//

	function showError(err) {
		const message = (err && err.message || 'Something went wrong');

		if (err instanceof Error) {
			console.error(err.stack);
		}

		swal('Oops...', message, 'error');
	}

	function newSnippet(code) {
		return {
			id: gid++,
			code: code || '',
			status: ''
		};
	}

	function formatNumber(number) {
		number = String(number).split('.');

		return number[0].replace(/(?=(?:\d{3})+$)(?!\b)/g, ',') + (number[1] ? '.' + number[1] : '');
	}

	function getName(snippet) {
		return (snippet.code !== undefined ? snippet.code : snippet)
			.trim()
			.split('\n')[0].replace(/(^\/[*/]+|\**\/$)/g, '')
			.trim();
	}

	function toStringBench(bench) {
		const error = bench.error;
		const hz = bench.hz;
		const stats = bench.stats;
		const size = stats.sample.length;

		if (error) {
			return error;
		} else {
			return (
				formatNumber(hz.toFixed(hz < 100 ? 2 : 0)) + ' ops/sec<br/>' +
				'\xb1' + stats.rme.toFixed(2) + '%<br/>' +
				'(' + size + ' run' + (size === 1 ? '' : 's') + ' sampled)'
			);
		}
	}

	function getGistLastRevisionId(gist) {
		let i = 0;
		const history = gist.history;
		const n = history.length;

		for (; i < n; i++) {
			if (history[i].change_status.total > 0) {
				return history[i].version;
			}
		}

		return gist.id;
	}

	// Init
	OAuth.initialize(OAUTH_PUBLIC_KEY);
	window.app = new UIApp().renderTo(document.getElementById('canvas'));
})(window.feast, window.Benchmark, window.OAuth, window.github, window.share, window.sweetAlert);

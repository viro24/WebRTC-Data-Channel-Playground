/*-
 * Copyright (c) 2015 Daniel Richters, Felix Weinrank
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 *
 */

/*
 BASED ON: http://louisstow.github.io/WebRTC/datachannels.html
 */

/*
 * SETTINGS BEGIN
 */

var options = {
	iceOfferAll : false,
};

// ICE, STUN, TURN Servers
var iceServer = {
	iceServers : [{
		urls : 'stun:stun.l.google.com:19302'
	}, {
		urls : 'stun:stun1.l.google.com:19302'
	}, {
		urls : 'stun:stun2.l.google.com:19302'
	}, {
		urls : 'stun:stun3.l.google.com:19302'
	}, {
		urls : 'stun:stun4.l.google.com:19302'
	}]
};

// constraints on the offer SDP.
var sdpConstraints = {
	'mandatory' : {
		'OfferToReceiveAudio' : false,
		'OfferToReceiveVideo' : false
	}
};

// Reference to Firebase APP
var dbRef = new Firebase("https://webrtc-data-channel.firebaseio.com/");

/*
* SETTINGS END
*/

// shims - wrappers for webkit and mozilla connections
var PeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
var IceCandidate = window.mozRTCIceCandidate || window.RTCIceCandidate;
var SessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription || window.RTCSessionDescription;

var activeChannelCount = -1;
var refreshCounter = 0;
var channels = {};
var channelStats = [];
var channelStatsCounter = 0;
var dcCounter = 0;
var labelButtonToggle = false;
var localIceCandidates = [];
var offerer = false;
var parameters = {};
var pc = new PeerConnection(iceServer);
var peerIceCandidates = [];
var peerRole = "offerer";
var role = "answerer";
var scheduler = new Worker("dist/worker.scheduler.js");
var signalingID;
var freshSignalingID = generateSignalingID();
var signalingIDRef = dbRef.child("npmIDs");
var t_startNewPackage = 0;




// Google Chart
var chartOptions = {
	title : 'DC Performance',
	legend : {
		position : 'bottom'
	},
	animation : {
		duration : 1000,
		easing : 'out'
	}
};
var chartData;

var chart = new google.visualization.LineChart(document.getElementById('channelChart'));

// clean firebase ref
signalingIDRef.child(freshSignalingID).remove();
$('#signalingID').val(location.hash.substring(1));

prepareRole();

function prepareRole() {
	// role offerer
	if ($('#signalingID').val() != '') {

		if ($('#signalingID').val() != '') {
			signalingID = $('#signalingID').val();
		}
		role = "answerer";
		peerRole = "offerer";

		$('#statusSigID').html(signalingID);
		$('#statusRole').html(role);
		$('#npmChannelParametersContainer').hide();

		// role answerer
	} else {
		role = 'offerer';
		peerRole = 'answerer';
		signalingID = freshSignalingID;
		$('#statusRole').html(role);
		$('#statusSigID').html("<a href='#" + signalingID + "'>" + signalingID + "</a>");
		$('#npmChannelParametersContainer').show();

	};
}

// generate a unique-ish string for storage in firebase
function generateSignalingID() {
	return (Math.random() * 10000 + 10000 | 0).toString();
}

// wrapper to send data to FireBase
function firebaseSend(signalingID, key, data) {
	signalingIDRef.child(signalingID).child(key).set(data);
	console.log('firebaseSend - ' + key + ' - ' + data);
}

// wrapper function to receive data from FireBase - with callback function
function firebaseReceive(signalingID, type, cb) {
	signalingIDRef.child(signalingID).child(type).on("value", function(snapshot, key) {
		var data = snapshot.val();
		if (data) {
			cb(data);
			console.log('firebaseReceive - ' + type + ' - ' + data);
		}
	});
}

// generic error handler
function errorHandler(err) {
	console.error(err);
}

// find and return an IPv4 Address from a given string
function extractIpFromString(string) {
	var pattern = '(?:25[0-5]|2[0-4][0-9]|1?[0-9][0-9]{1,2}|[0-9]){1,}(?:\\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2}|0)){3}';
	var match = string.match(pattern);
	return match[0];
}

// handle local ice candidates
pc.onicecandidate = function(event) {
	// take the first candidate that isn't null
	if (!pc || !event || !event.candidate) {
		return;
	}

	var ip = extractIpFromString(event.candidate.candidate);

	// if filter is set: ignore all other addresses
	if ($('#localIceFilter').val() != '' && $('#localIceFilter').val() != ip) {
		return;
	}

	// add local candidates only once to statusinfo
	if (localIceCandidates.indexOf(ip) == -1) {
		localIceCandidates.push(ip);
		$('#localIceCandidates').append(ip + '<br/>');
	}

	// add local ice candidate to firebase
	signalingIDRef.child(signalingID).child(role + '-iceCandidates').push(JSON.stringify(event.candidate));

	console.log('onicecandidate - ip:' + ip);

	updatePeerConnectionStatus(event);
};

pc.onsignalingstatechange = function(event) {
	updatePeerConnectionStatus(event);
};

pc.oniceconnectionstatechange = function(event) {
	updatePeerConnectionStatus(event);
};

// establish connection to remote peer via webrtc
function connect() {

	// disable inputs
	$('#npmConnect').prop('disabled', true);
	$('#signalingID').prop('disabled', true);
	$('#localIceFilter').prop('disabled', true);
	$('#npmLoadSettings').prop('disabled', true);

	if (role === "offerer") {

		channelCreate('init');
		// create the offer SDP
		pc.createOffer(function(offer) {
			pc.setLocalDescription(offer);

			// send the offer SDP to FireBase
			firebaseSend(signalingID, "offer", JSON.stringify(offer));

			// wait for an answer SDP from FireBase
			firebaseReceive(signalingID, "answer", function(answer) {
				pc.setRemoteDescription(new SessionDescription(JSON.parse(answer)));
			});
		}, errorHandler, sdpConstraints);

		console.log("connect - role: offerer");

		// answerer role
	} else {

		// answerer must wait for the data channel
		pc.ondatachannel = function(event) {
			bindEvents(event.channel);
			console.log('incoming datachannel');
			updateChannelStatus();
		};

		// answerer needs to wait for an offer before generating the answer SDP
		firebaseReceive(signalingID, "offer", function(offer) {
			pc.setRemoteDescription(new SessionDescription(JSON.parse(offer)));

			// now we can generate our answer SDP
			pc.createAnswer(function(answer) {
				pc.setLocalDescription(answer);

				// send it to FireBase
				firebaseSend(signalingID, "answer", JSON.stringify(answer));
			}, errorHandler, sdpConstraints);
		});
		console.log('connect - role answerer');
	}

	// add handler for peers ice candidates
	signalingIDRef.child(signalingID).child(peerRole + '-iceCandidates').on('child_added', function(childSnapshot) {
		var childVal = childSnapshot.val();
		var peerCandidate = JSON.parse(childVal);

		var peerIceCandidate = new IceCandidate(peerCandidate);
		pc.addIceCandidate(new IceCandidate(peerCandidate));

		var peerIp = extractIpFromString(peerIceCandidate.candidate);
		if (peerIceCandidates.indexOf(peerIp) == -1) {
			peerIceCandidates.push(peerIp);
			$('#peerIceCandidates').append(peerIp + '<br/>');
		}

		//console.log(peerIceCandidate);
		console.log('peerIceCandidate: ' + peerIp);
	});
}

//create new datachannel
function channelCreate(label) {
	// set options for datachannel
	var dataChannelOptions;
	if ( typeof parameters[label] != 'undefined') {
		var sendModeArray = parameters[label].sendMode.split(':');
		switch(sendModeArray[0]) {
		case "":
			dataChannelOptions = {
			};
			break;
		case "rt":
			dataChannelOptions = {
				maxRetransmits : sendModeArray[1],
			};
			break;
		case "timeout":
			dataChannelOptions = {
				maxPacketLifeTime : sendModeArray[1],
			};
			break;
		}
	}

	// offerer creates the data channel
	var newChannel = pc.createDataChannel(label, dataChannelOptions);
	bindEvents(newChannel);

	channels[newChannel.label] = {
		channel : newChannel,
		statistics : {
			t_start : 0,
			t_end : 0,
			t_last : 0,
			tx_pkts : 0,
			tx_bytes : 0,
			tx_bytes_last : 0,
			tx_rate_avg : 0,
			tx_rate_cur : 0,
			rx_pkts : 0,
			rx_bytes : 0,
			rx_bytes_last : 0,
			rx_rate_avg : 0,
			rx_rate_cur : 0
		}

	};

	updateChannelStatus();
	console.log("createDataChannel - label:" + newChannel.label + ', id:' + newChannel.id);
}

function closeDataChannel(label) {
	console.log('closeDataChannel - channel:' + label);
	channels[label].channel.close();
}

function validateParameters() {
	var inputValid = true;
	$('#npmChannelParameters > tbody > tr input').each(function() {
		$(this).removeClass('has-error');
		
		switch ($(this).attr('name')) {	
			// gt 0
			case 'paramPktCount':
			case 'paramRuntime':
			case 'paramDelay':
				var pattern = /^(\d+)$/g;
				var string	= $(this).val();
				if(!string.match(pattern)) {
					$(this).addClass('has-error');
					console.log('validation error');
					inputValid = false;
				}
				break;
				
			// pattern: number || const:number || exp:number || uniform:number:number
			case 'paramInterval':
			case 'paramPktSize':
			
				var pattern = /^(\d+|const:\d+|exp:\d+|uniform:\d+:\d+)$/g;
				var string	= $(this).val();
				if(!string.match(pattern)) {
					$(this).addClass('has-error');
					console.log('validation error');
					inputValid = false;
				}
				break;
				
			case 'paramMode':
				var pattern = /^(rt:\d+|to:\d+)$/g;
				var string	= $(this).val();
				if(string.length > 0 && !string.match(pattern)) {
					$(this).addClass('has-error');
					console.log('validation error');
					inputValid = false;
				}
				break;
		}
	});
	
	return inputValid;
}


// read parameters from table and save in parameters object
function parseParameters() {
	$('#npmChannelParameters > tbody > tr').each(function() {
		parameters[$(this).find('button[name="toggleActive"]').val()] = {
			active : $(this).find('button[name="toggleActive"]').hasClass("btn-success"),
			label : $(this).find('button[name="toggleActive"]').val(),
			pktSize : $(this).find('input[name="paramPktSize"]').val(),
			pktCount : parseInt($(this).find('input[name="paramPktCount"]').val()),
			sendInterval: $(this).find('input[name="paramInterval"]').val(),
			sendMode : $(this).find('input[name="paramMode"]').val(),
			runtime : parseInt(($(this).find('input[name="paramRuntime"]').val() * 1000)),
			delay : parseInt(($(this).find('input[name="paramDelay"]').val() * 1000))
		};
	});

	console.log(parameters);
}

/*
 * generate a random uniformed integer between min and max
 */
function randomUniform(min,max)  {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

/*
 * test random unform
 */
function randomUniformTest(min,max,runs) {
	var sum = 0;
	for(i=0;i<runs;i++) {
		sum += randomUniform(min,max);
	}
	return sum/runs;
}

/*
 * generate a random exponential integer
 */
function randomExponential(expectation) {
	return Math.round(Math.abs(Math.log(Math.random())/(1/expectation)));
}

/*
 * test random exponential
 */
function randomExponentialTest(expectation,runs) {
	var sum = 0;
	for(i=0;i<runs;i++) {
		num = randomExponential(expectation);
		sum += num;
		console.log(num);
	}
	return sum/runs;
}

function randomWrapper(funcstring) {
	var paramArray = funcstring.split(':');
	
	if(paramArray.length == 1) {
		return parseInt(funcstring);
	} else {
		switch(paramArray[0]) {
			case 'const':
				return parseInt(paramArray[1]);
				break;
			
			case 'exp':
				return randomExponential(parseInt(paramArray[1]));
				break;
				
			case 'uniform':
				return randomUniform(parseInt(paramArray[1]),parseInt(paramArray[2]));
				break;
			default:
				throw "random function unknown!";
		}
	}
} 

// run npm - read parameters and create datachannels
function npmStart() {
	
	if(!validateParameters()) {
		return;
	}
	parseParameters();

	//channels[init].channel.send(parameters);

	var npmChannelLabels = [];
	npmChannelLabels.push('timestamp');

	for (var label in parameters) {
		console.log('netPerfMeter - send');
		if (parameters.hasOwnProperty(label)) {
			if (parameters[label].active == true) {
				npmChannelLabels.push(label);
				channelCreate(label);
			}
		}
	}

	var collectStatsMessage = {
		type : 'collectStats',
		data : npmChannelLabels
	};
	console.log(npmChannelLabels);
	channels['init'].channel.send(JSON.stringify(collectStatsMessage));

}

function npmSend(label) {

	if (label == 'init') {
		alert('init darf das nicht!');
	}

	if (channels[label].statistics.t_start == 0) {
		channels[label].statistics.t_start = new Date().getTime();
	}

	try {
		channels[label].statistics.t_end = new Date().getTime();
		var runtime = (channels[label].statistics.t_end - channels[label].statistics.t_start);
		var message = generateByteString(randomWrapper(parameters[label].pktSize));

		if (runtime <= parameters[label].runtime) {

			if (channels[label].channel.bufferedAmount < 30000) {
				channels[label].channel.send(message);
				channels[label].statistics.tx_pkts++;
				channels[label].statistics.tx_bytes += message.length;
			} else {
				console.log('npmSend - bufferedAmount >= 30000');
			}

			if (channels[label].statistics.tx_pkts < parameters[label].pktCount) {
				var schedulerObject = {
					type : 'npmSendTrigger',
					sleep : randomWrapper(parameters[label].sendInterval),
					data : label
				};
				scheduler.postMessage(schedulerObject);
			} else {
				console.log('npmSend - channel:' + label + ' - all pkts sent');
				closeDataChannel(label);
			}
		} else {
			closeDataChannel(label);
			console.log('npmSend - channel:' + label + ' - runtime reached');
		}
	} catch(e) {
		alert("Test Aborted!");
		console.log(e);
		return;
	}

	//updateChannelState();
};

// reset npm for next benchmark
function npmReset() {
	for (var label in channels) {
		if (channels.hasOwnProperty(label)) {
			if (label != 'init') {
				delete channels[label];
			}	
		}
	}
	
	for (var label in parameters) {
		if (parameters.hasOwnProperty(label)) {
			if (label != 'init') {
				delete parameters[label];
			}	
		}
	}
	
	channelStats.length = 0;

	console.log('npmReset');
}

// bind the channel events
function bindEvents(channel) {
	channel.onopen = function() {

		// datachannel openend on offerer-side
		if (role == 'offerer') {
			if (channel.label == "init") {
				$('#npmRun').prop('disabled', false);
			} else {
				$('#npmRun').prop('disabled', true);

				// start netperfmeter after defined delay
				setTimeout(function() {
					npmSend(channel.label);
				}, parameters[channel.label].delay);
			}

			// datachannel openend on answerer-side
		} else {
			channels[channel.label] = {
				channel : channel,
				statistics : {
					t_start : 0,
					t_end : 0,
					t_last : 0,
					tx_pkts : 0,
					tx_bytes : 0,
					tx_bytes_last : 0,
					tx_rate_avg : 0,
					tx_rate_cur : 0,
					rx_pkts : 0,
					rx_bytes : 0,
					rx_bytes_last : 0,
					rx_rate_avg : 0,
					rx_rate_cur : 0
				}
			};
		}

		updateChannelStatus();
		console.log("datachannel opened - label:" + channel.label + ', ID:' + channel.id);
	};

	// after close: update channel stats
	channel.onclose = function(e) {
		updateChannelStatus();
		console.log("datachannel closed - label:" + channel.label + ', ID:' + channel.id);
	};

	window.onbeforeunload = function() {
		channel.close();
	};

	// handle messages
	channel.onmessage = function(e) {

		// control messages on init-channel
		if (e.currentTarget.label == 'init') {
			handleJsonMessage(e.data);
			// handle data messages
		} else if (role == 'answerer') {
			handleDataMessage(e);
		}
	};
}

// scheduler only used for npmSend
scheduler.onmessage = function(e) {
	var message = e.data;

	if (message.data != undefined && message.sleep != undefined && message.type != undefined) {
		switch(message.type) {
		case 'npmSendTrigger':
			npmSend(message.data);
			break;
		case 'recordStatsVector':
			recordStats();
			break;
		default:
			alert('scheduler - unknown messagetype!');
			break;
		}

	}
};

function handleDataMessage(e) {
	rxDataLength = e.data.toString().length;

	var label = e.currentTarget.label;
	if (channels[label].statistics.t_start == 0) {
		channels[label].statistics.t_start = new Date().getTime();
	}
	channels[label].statistics.t_end = new Date().getTime();
	channels[label].statistics.rx_bytes += rxDataLength;
	channels[label].statistics.rx_pkts++;
}

function handleJsonMessage(message) {
	var messageObject = JSON.parse(message);
	var tempChannelLabel = messageObject.label;

	switch(messageObject.type) {

	// statistics
	case 'statistics':
		break;

	// timestamp - echo timestamp to sender
	case 'timestamp':
		handlePing(messageObject);
		break;

	// timestampEcho - measure RTT
	case 'timestampEcho':
		handlePingEcho(messageObject);
		break;
	case 'collectStats':
		statsCollectInit(messageObject);
		break;
	default:
		alert('Unknown messagetype!!');
		break;
	}
}

function statsCollectInit(messageObject) {
	$('#channelChart').show();
	channelStats.push(messageObject.data);
	console.log(channelStats);
	setTimeout(statsCollect, 500);
}

function statsCollect() {
	var activeChannels = 0;

	var tempTime = new Date().getTime();
	var tempRxRate = 0;
	var tempStatsArray = [];
	tempStatsArray.push(channelStatsCounter++);

	for (var i = 1; i < channelStats[0].length; i++) {
		var label = channelStats[0][i];
		//alert(label);
		if (channels[label].channel.readyState == 'open') {
			activeChannels++;

			tempRxRate = (channels[label].statistics.rx_bytes - channels[label].statistics.rx_bytes_last) / (tempTime - channels[label].statistics.t_last) * 1000;
			tempStatsArray.push(tempRxRate);

			channels[label].statistics.rx_bytes_last = channels[label].statistics.rx_bytes;
			channels[label].statistics.t_last = tempTime;

		} else {
			tempStatsArray.push(0);
		}
	}

	channelStats.push(tempStatsArray);

	if (activeChannels > 0) {
		setTimeout(statsCollect, 1000);
	} else {
		console.log('statsCollect - no active channels left!');
		statsDrawChart();
	}
}

function statsDrawChart() {

	if (channelStats.length < 2) {
		return;
	}

	chartData = google.visualization.arrayToDataTable(channelStats);
	chart.draw(chartData, chartOptions);
}

/*
 * generate a string with given length (byte)
 */

function generateByteString(length) {
	var str = new Array(length + 1).join('x');
	return str;
}

/*
 * conver sizes
 * http://stackoverflow.com/questions/15900485/correct-way-to-convert-size-in-bytes-to-kb-mb-gb-in-javascript
 */

function bytesToSize(bytes) {
	if (bytes == 0)
		return '0 Byte';
	var k = 1000;
	var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
	var i = Math.floor(Math.log(bytes) / Math.log(k));
	return (bytes / Math.pow(k, i)).toPrecision(3) + ' ' + sizes[i];
}


/*
 * Send a message to peer with local timestamp
 */
function ping() {
	var date = new Date();
	timestampMessage = {
		type : 'timestamp',
		timestamp : date.getTime(),
	};
	channels.init.channel.send(JSON.stringify(timestampMessage));
	console.log('ping - sending timestamp to peer: ' + timestampMessage.timestamp);
}

/*
 * Echo received timestamp to peer
 */
function handlePing(message) {
	var timestampEcho = message;
	timestampEcho.type = 'timestampEcho';
	channels.init.channel.send(JSON.stringify(timestampEcho));
	console.log('handlePing - echo received timestamp to peer: ' + timestampEcho.timestamp);
}

/*
 * evaluate received Echo
 */
function handlePingEcho(message) {
	var date = new Date();
	var t_delta = date.getTime() - message.timestamp;
	$('#npmcPing .rtt').html(' - RTT: ' + t_delta + ' ms');
	console.log('handlePingEcho - received echoed timestamp from peer - RTT: ' + t_delta);
}

/*
 * Save the channel settings to webstorage
 */
function channelSettingsSave() {
	$('#npmChannelParameters > tbody > tr > td > input').each(function() {
		$(this).attr('value', $(this).val());
	});

	//var channelSettingsHTML = $("#npmChannelParameters tbody").html();
	localStorage.setItem('npmChannelSettings', $("#npmChannelParameters tbody").html());
	localStorage.setItem('localIceFilter', $('#localIceFilter').val());
	
	console.log('settings saved');
}

/*
 * load channel settings from webstorage
 */
function channelSettingsLoad() {

	var channelSettingsHTML = localStorage.getItem('npmChannelSettings');
	var localIceFilter = localStorage.getItem('localIceFilter');

	if (localIceFilter) {
		$("#localIceFilter").val(localIceFilter);
	}

	if (channelSettingsHTML) {
		$("#npmChannelParameters tbody").html(channelSettingsHTML);
	}

	if (!localIceFilter && !channelSettingsHTML) {
		alert('Sorry - No saved settings available!');
	}
	
	console.log('settings loaded');
}
/*
 * Show settings editor
 */
function channelSettingsEditorShow() {
	$('#npmChannelParameters > tbody > tr > td > input').each(function() {
		$(this).attr('value', $(this).val());
	});
	
	$('#channelSettingsEditorTextarea').val($("#npmChannelParameters tbody").html());
}

/*
 * Save settings from editor
 */
function channelSettingsEditorApply() {
	$("#npmChannelParameters tbody").html($('#channelSettingsEditorTextarea').val());
	console.log('settings applied');
}

// ==UserScript==
// @name         Add One-Hand & Flick Gesture Area
// @version      2023.11.17
// @description  Tap to lower the screen & Flick left/right/bottom to go forward/back/Bottom of the page and Long press to hide
// @author       Fumizo
// @include      http://*
// @include      https://*
// @exclude      *://*.jpg
// @exclude      *://*.png
// @exclude      *://*.gif
// @exclude      *://*.gifv
// @run-at       document-end
// ==/UserScript==


// 自分自身が親(iframeで読み込まれていない場合)
if(window == window.parent) {

var button2 = document.createElement('button');
button2.setAttribute('type', 'button');
button2.setAttribute('id', 'bottom-button');
button2.innerHTML = "&#8661;";

document.body.appendChild(button2);

const button2Css = document.createElement('style');
button2Css.textContent = `
#bottom-button {
  display: block !important;
  position: fixed !important;
  bottom: 10% !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
  font-family: 'sans-serif' !important;
  font-size: 30px !important;
  font-weight: 500 !important;
  font-style: normal !important;
  color: #fff !important;
  background: rgba(0, 0, 0, 0.5) !important;
  box-sizing: border-box !important;
  border: 1px solid #ccc !important;
  border-radius: 50% !important;
  width: 40px !important;
  height: 40px !important;
  line-height: 40px !important;
  margin: 0 !important;
  padding: 0 !important;
  outline: 0 !important;
  vertical-align: baseline !important;
  quotes: none !important;
  text-decoration: none !important;
  letter-spacing: normal !important;
  user-select: none !important;
  z-index: 9999999 !important;
}
#bottom-button::before, #bottom-button::after {
  content: none !important;
}
`;

document.body.appendChild(button2Css);

const htmlBottom = document.createElement('style');
htmlBottom.textContent = `
html::before {
  background: #d7d7db;
  height: 0vh;
  display: block;
  transition: height .5s;
  content: "";
}
html.SGMT::before {
  height: 60vh;
}
.SGMT .SGMT-FIXED {
  top: 60vh;
}
`;

document.head.appendChild(htmlBottom);

button2.addEventListener('click',() => {
  window.scrollTo({top: 0, behavior: 'smooth'});
  document.documentElement.classList.toggle('SGMT');
  window._SGMT_ = {
    reset: e => {
      if (e.target.tagName != 'HTML') return;
      document.documentElement.classList.remove('SGMT');
    },
  };
  let f = document.elementFromPoint(0, 0);
  while (f) {
    if (f.tagName === 'BODY' || f.tagName === 'HTML') break;
    if (getComputedStyle(f).getPropertyValue('position') === 'fixed') {
      f.classList.add('SGMT-FIXED');
      break;
    }
    f = f.parentNode;
  }
  addEventListener('click', _SGMT_.reset);
  setTimeout(_SGMT_.apply, 10);
});


var mouseDown = false;
var thresholdX = 10;
var thresholdY = 15;
var position = null;
var timer = null;
var log = [];

button2.addEventListener('touchstart',function (e) {
  mouseDown = true;
  position = {
    x: e.touches[0].pageX - document.body.offsetLeft,
    y: e.touches[0].pageY - document.body.offsetTop
  };
});

button2.addEventListener('touchend',function () {
  mouseDown = false;

  if (log.length == 0) return;

  var prev = log[0];
  var moveX = 0;
  var moveY = 0;
  for (var i = 1; i < log.length; i++) {
    moveX += log[i].x - prev.x;
    moveY += log[i].y - prev.y;
  }
  if (Math.abs(moveX) > thresholdX) {
    if (moveX > 0 && Math.abs(moveY) < thresholdY) {
      history.back();
    } else {
      history.forward();
    }
  }
  if (Math.abs(moveY) > thresholdY) {
    if (moveY > 0 && Math.abs(moveX) < thresholdX) {
      var elm = document.documentElement;
      //scrollHeight ページの高さ clientHeight ブラウザの高さ
      var bottom = elm.scrollHeight - elm.clientHeight;
      window.setTimeout(function(){
        window.scrollTo({top: bottom, behavior: 'smooth'});
      }, 100);
    }
  }
  moveX = null;
  moveY = null;
  position = null;
  prev = null;
  log = [];
  log.length = 0;
});

button2.addEventListener('touchmove',function (e) {
  if (mouseDown !== true) return;
  x = e.touches[0].pageX - document.body.offsetLeft;
  y = e.touches[0].pageY - document.body.offsetTop;
  logPosition(x,y);
  e.preventDefault();//触ってる間スクロール禁止
});

function logPosition(x,y) {
  log.push({ x: x,y: y });
  if (log.length > 3) log.shift();
}

//ロングタップで非表示
var check_sec = 500; //ミリ秒

long_press(button2,normal_func,long_func,check_sec);

function normal_func() {
  return;
}
function long_func(){
  button2.remove()
}

function long_press(el,nf,lf,sec) {
  let longclick = false;
  let longtap = false;
  let touch = false;
  let timer;
  el.addEventListener('touchstart',()=>{
    touch = true;
    longtap = false;
    timer = setTimeout(() => {
      longtap = true;
      lf();
    }, sec);
  })
  el.addEventListener('touchend',()=>{
    if(!longtap){
      clearTimeout(timer);
      nf();
    }else{
      touch = false;
    }
  })

  el.addEventListener('mousedown',()=>{
    if(touch) return;
    longclick = false;
    timer = setTimeout(() => {
      longclick = true;
      lf();
    }, sec);
  })
  el.addEventListener('click',()=>{
    if(touch){
      touch = false;
      return;
    }
    if(!longclick){
      clearTimeout(timer);
      nf();
    }
  });
}
}

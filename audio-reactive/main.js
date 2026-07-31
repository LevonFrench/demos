import { AudioController } from './audio.js';
import { Visualizer } from './visualizer.js';

let audioController;
let visualizer;
let isPlaying = false;

function init() {
  const appContainer = document.getElementById('app');
  visualizer = new Visualizer(appContainer);

  const audioUpload = document.getElementById('audio-upload');
  const playBtn = document.getElementById('play-btn');
  const pauseBtn = document.getElementById('pause-btn');

  audioUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      if (!audioController) {
        audioController = new AudioController();
        audioController.onEnded = () => {
          isPlaying = false;
          playBtn.disabled = false;
          pauseBtn.disabled = true;
        };
      }
      audioController.loadAudio(file);
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      isPlaying = false;
    }
  });

  playBtn.addEventListener('click', () => {
    if (audioController) {
      audioController.play();
      isPlaying = true;
      playBtn.disabled = true;
      pauseBtn.disabled = false;
    }
  });

  pauseBtn.addEventListener('click', () => {
    if (audioController) {
      audioController.pause();
      isPlaying = false;
      playBtn.disabled = false;
      pauseBtn.disabled = true;
    }
  });

  // Start loop
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  
  let audioData = null;
  if (audioController && isPlaying) {
    audioData = audioController.getFrequencyData();
  }
  
  visualizer.update(audioData);
  visualizer.render();
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', init);

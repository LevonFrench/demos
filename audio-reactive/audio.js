export class AudioController {
  constructor() {
    this.context = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.8;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    
    this.source = null;
    this.audioElement = new Audio();
    this.audioElement.addEventListener('ended', () => {
      if (this.onEnded) this.onEnded();
    });

    // Create media element source
    this.source = this.context.createMediaElementSource(this.audioElement);
    this.source.connect(this.analyser);
    this.analyser.connect(this.context.destination);
  }

  loadAudio(file) {
    const url = URL.createObjectURL(file);
    this.audioElement.src = url;
  }

  play() {
    if (this.context.state === 'suspended') {
      this.context.resume();
    }
    this.audioElement.play();
  }

  pause() {
    this.audioElement.pause();
  }

  getFrequencyData() {
    this.analyser.getByteFrequencyData(this.dataArray);
    return this.dataArray;
  }
}

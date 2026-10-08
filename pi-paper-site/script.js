'use strict';
const shots = {
  canvas: {image:'assets/canvas-workflow.webp', heading:'让参考、镜头和结果，连在一起。', description:'一张画布容纳完整的创作上下文。连线保留素材与结果的关系，小P就在旁边，陪你推进下一步。', alt:'真实画布中连接的参考、视频和合成节点'},
  editor: {image:'assets/image-editor.webp', heading:'从一个节点，打磨每一个细节。', description:'在原画布编辑器里选择模型、调整生成参数、检查参考。生成状态和结果回到节点，继续你的创作。', alt:'Pi-Paper 图像节点编辑器与生成选项实拍'},
  models: {image:'assets/provider-configuration.webp', heading:'模型由你选择，参数由你设定。', description:'在 API 配置中填写自己的凭据，启用已实现的模型并保存默认参数。可用能力以当前适配目录为准。', alt:'Pi-Paper 官方提供方与模型配置页面实拍'}
};
const tabs = [...document.querySelectorAll('[data-showcase]')];
function selectShot(tab) {
  const shot = shots[tab.dataset.showcase];
  tabs.forEach(item => {item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1;});
  document.querySelector('#showcase-panel').setAttribute('aria-labelledby', tab.id);
  const img = document.querySelector('#showcase-img');
  img.src = shot.image; img.alt = shot.alt;
  document.querySelector('#showcase-heading').textContent = shot.heading;
  document.querySelector('#showcase-description').textContent = shot.description;
  const preview = document.querySelector('#showcase-preview');
  preview.dataset.preview = shot.image; preview.dataset.caption = shot.heading;
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectShot(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault(); selectShot(tabs[next]); tabs[next].focus();
  });
});
const dialog = document.querySelector('#image-dialog');
document.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', () => {
  const img = document.querySelector('#dialog-image');
  img.src = button.dataset.preview; img.alt = button.dataset.caption;
  document.querySelector('#dialog-caption').textContent = button.dataset.caption;
  dialog.showModal();
}));
document.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if(event.target === dialog) {const bounds=dialog.getBoundingClientRect(); if(event.clientX<bounds.left || event.clientX>bounds.right || event.clientY<bounds.top || event.clientY>bounds.bottom) dialog.close();} });

// Progressive enhancement: static content remains readable without motion support.
function setupScrollMotion() {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!('IntersectionObserver' in window)) return;
  const revealElements = new Set();
  const addReveal = (selector, stagger = false) => {
    document.querySelectorAll(selector).forEach((element, index) => {
      element.classList.add('scroll-reveal');
      if (stagger) element.classList.add(`motion-step-${index % 4}`);
      revealElements.add(element);
    });
  };
  addReveal('.manifesto > .eyebrow, .manifesto > h2, .manifesto-bottom, .section-heading, .showcase-tabs, .showcase-image, .showcase-caption, .workflow-sketch, .xiaop-copy, .xiaop-art, .ownership > div:first-child, .download-top, .download-heading, .release-note, footer');
  ['.capability-strip > div', '.workflow-rows > div', '.ownership-list > div', '.faq-list > details', '.download-platforms > a'].forEach(selector => addReveal(selector, true));
  const sketch = document.querySelector('.workflow-sketch');
  sketch.querySelector('path').setAttribute('pathLength', '1');
  let observer;
  let effects = [];
  let frame = 0;

  const reveal = element => {
    element.classList.add('is-revealed');
    observer?.unobserve(element);
  };

  function updateEffects() {
    frame = 0;
    if (preference.matches || document.hidden) return;
    const height = window.innerHeight;
    // Read geometry together, then update compositor animations together.
    const positions = effects.map(effect => effect.anchor.getBoundingClientRect());
    effects.forEach((effect, index) => {
      const bounds = positions[index];
      if (bounds.bottom < 0 || bounds.top > height) return;
      const progress = effect.enterOnly
        ? (height - bounds.top) / (height * 0.8)
        : (height - bounds.top) / (height + bounds.height);
      effect.animation.currentTime = Math.min(1, Math.max(0, progress)) * 1000;
    });
  }

  const schedule = () => {
    if (!frame && !preference.matches && !document.hidden) frame = requestAnimationFrame(updateEffects);
  };

  function createEffects() {
    effects.forEach(effect => effect.animation.cancel());
    effects = [];
    if (preference.matches || !Element.prototype.animate) return;
    const distance = window.innerWidth <= 700 ? 6 : 18;
    const addEffect = (selector, anchorSelector, keyframes, enterOnly = false) => {
      const element = document.querySelector(selector);
      const animation = element.animate(keyframes, {duration:1000, fill:'both', easing:'linear'});
      animation.pause();
      animation.currentTime = 0;
      effects.push({animation, anchor:document.querySelector(anchorSelector), enterOnly});
    };
    addEffect('.canvas-preview img', '.hero-stage', [{transform:'scale(1.045)'}, {transform:'scale(1)'}], true);
    addEffect('.paper-sticker', '.hero-stage', [{transform:`translateY(${distance}px) rotate(10deg)`}, {transform:`translateY(${-distance}px) rotate(3deg)`}]);
    addEffect('.showcase-image img', '.showcase-image', [{transform:'scale(1.035)'}, {transform:'scale(1)'}], true);
    addEffect('.xiaop-art img', '.xiaop-section', [{transform:`translateY(${distance}px) rotate(1.2deg)`}, {transform:`translateY(${-distance}px) rotate(-1.2deg)`}]);
    schedule();
  }

  function applyPreference() {
    observer?.disconnect();
    document.documentElement.classList.toggle('motion-enabled', !preference.matches);
    if (preference.matches) {
      revealElements.forEach(reveal);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    } else {
      observer = new IntersectionObserver(entries => {
        entries.forEach(entry => { if (entry.isIntersecting) reveal(entry.target); });
      }, {threshold:0, rootMargin:'0px 0px -6% 0px'});
      revealElements.forEach(element => {
        const bounds = element.getBoundingClientRect();
        // Keep restored positions and the initially visible screen readable.
        if (bounds.top < window.innerHeight * 0.94) reveal(element);
        else observer.observe(element);
      });
    }
    createEffects();
  }

  document.addEventListener('focusin', event => {
    const element = event.target.closest('.scroll-reveal');
    if (element) reveal(element);
  });
  window.addEventListener('scroll', schedule, {passive:true});
  window.addEventListener('resize', createEffects, {passive:true});
  document.addEventListener('visibilitychange', schedule);
  preference.addEventListener('change', applyPreference);
  applyPreference();
}
setupScrollMotion();

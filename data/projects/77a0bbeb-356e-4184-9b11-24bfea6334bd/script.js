// Get all elements
const header = document.getElementById('header');
const nav = document.getElementById('nav');
const menuBtn = document.getElementById('menu-btn');
const navList = document.getElementById('nav-list');
const homeLink = document.getElementById('home-link');
const featuresLink = document.getElementById('features-link');
const productsLink = document.getElementById('products-link');
const heroTitle = document.getElementById('hero-title');
const heroText = document.getElementById('hero-text');
const getStartedBtn = document.getElementById('get-started-btn');
const featuresTitle = document.getElementById('features-title');
const featuresList = document.getElementById('features-list');
const feature1Title = document.getElementById('feature-1-title');
const feature1Text = document.getElementById('feature-1-text');
const feature2Title = document.getElementById('feature-2-title');
const feature2Text = document.getElementById('feature-2-text');
const feature3Title = document.getElementById('feature-3-title');
const feature3Text = document.getElementById('feature-3-text');
const productsTitle = document.getElementById('products-title');
const productsList = document.getElementById('products-list');
const product1Title = document.getElementById('product-1-title');
const product1Text = document.getElementById('product-1-text');
const product1Btn = document.getElementById('product-1-btn');
const product2Title = document.getElementById('product-2-title');
const product2Text = document.getElementById('product-2-text');
const product2Btn = document.getElementById('product-2-btn');
const product3Title = document.getElementById('product-3-title');
const product3Text = document.getElementById('product-3-text');
const product3Btn = document.getElementById('product-3-btn');

// Add event listeners
menuBtn.addEventListener('click', () => {
  navList.classList.toggle('active');
});

homeLink.addEventListener('click', () => {
  window.location.href = '#home';
});

featuresLink.addEventListener('click', () => {
  window.location.href = '#features';
});

productsLink.addEventListener('click', () => {
  window.location.href = '#products';
});

getStartedBtn.addEventListener('click', () => {
  window.location.href = '#features';
});

product1Btn.addEventListener('click', () => {
  window.location.href = '#products';
});

product2Btn.addEventListener('click', () => {
  window.location.href = '#products';
});

product3Btn.addEventListener('click', () => {
  window.location.href = '#products';
});

// IntersectionObserver
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
    } else {
      entry.target.classList.remove('visible');
    }
  });
}, {
  threshold: 0.5,
});

// Observe sections
observer.observe(header);
observer.observe(nav);
observer.observe(heroTitle);
observer.observe(heroText);
observer.observe(getStartedBtn);
observer.observe(featuresTitle);
observer.observe(featuresList);
observer.observe(productsTitle);
observer.observe(productsList);

// LocalStorage
const storedData = localStorage.getItem('elevateData');
if (storedData) {
  const data = JSON.parse(storedData);
  // Use stored data
} else {
  const data = {
    morningRoutine: [],
    moodTracking: [],
    fitnessTrackers: [],
  };
  localStorage.setItem('elevateData', JSON.stringify(data));
}

// Page-load staggered animations
setTimeout(() => {
  heroTitle.classList.add('animate');
}, 50);

setTimeout(() => {
  heroText.classList.add('animate');
}, 100);

setTimeout(() => {
  getStartedBtn.classList.add('animate');
}, 150);

// Hover effects
getStartedBtn.addEventListener('mouseover', () => {
  getStartedBtn.style.transform = 'scale(1.05)';
  getStartedBtn.style.boxShadow = '0px 0px 10px rgba(0, 0, 0, 0.5)';
});

getStartedBtn.addEventListener('mouseout', () => {
  getStartedBtn.style.transform = 'scale(1)';
  getStartedBtn.style.boxShadow = 'none';
});

product1Btn.addEventListener('mouseover', () => {
  product1Btn.style.transform = 'scale(1.05)';
  product1Btn.style.boxShadow = '0px 0px 10px rgba(0, 0, 0, 0.5)';
});

product1Btn.addEventListener('mouseout', () => {
  product1Btn.style.transform = 'scale(1)';
  product1Btn.style.boxShadow = 'none';
});

product2Btn.addEventListener('mouseover', () => {
  product2Btn.style.transform = 'scale(1.05)';
  product2Btn.style.boxShadow = '0px 0px 10px rgba(0, 0, 0, 0.5)';
});

product2Btn.addEventListener('mouseout', () => {
  product2Btn.style.transform = 'scale(1)';
  product2Btn.style.boxShadow = 'none';
});

product3Btn.addEventListener('mouseover', () => {
  product3Btn.style.transform = 'scale(1.05)';
  product3Btn.style.boxShadow = '0px 0px 10px rgba(0, 0, 0, 0.5)';
});

product3Btn.addEventListener('mouseout', () => {
  product3Btn.style.transform = 'scale(1)';
  product3Btn.style.boxShadow = 'none';
});
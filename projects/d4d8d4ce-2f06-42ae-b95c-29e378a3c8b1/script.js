const nav = document.getElementById('nav');
const heroHeadline = document.querySelector('.hero-headline');

nav.addEventListener('scroll', () => {
    if (window.scrollY > 100) {
        nav.classList.add('scrolled');
    } else {
        nav.classList.remove('scrolled');
    }
});

heroHeadline.classList.add('animate');

const cards = document.querySelectorAll('.card');

cards.forEach((card) => {
    card.addEventListener('mouseover', () => {
        card.classList.add('hover');
    });
    card.addEventListener('mouseout', () => {
        card.classList.remove('hover');
    });
});

const buttons = document.querySelectorAll('button');

buttons.forEach((button) => {
    button.addEventListener('mouseover', () => {
        button.classList.add('hover');
    });
    button.addEventListener('mouseout', () => {
        button.classList.remove('hover');
    });
});

const footerForm = document.querySelector('footer form');

footerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.querySelector('footer input[type="email"]').value;
    localStorage.setItem('email', email);
});

const scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
        } else {
            entry.target.classList.remove('visible');
        }
    });
}, {
    rootMargin: '50px',
});

document.querySelectorAll('.section-title, .card, .plan, .testimonial-cards .card').forEach((element) => {
    scrollObserver.observe(element);
});

document.addEventListener('DOMContentLoaded', () => {
    const staggerElements = document.querySelectorAll('.hero-headline, .section-title, .card, .plan, .testimonial-cards .card');

    staggerElements.forEach((element, index) => {
        element.style.animationDelay = `${index * 0.1}s`;
        element.classList.add('animate');
    });
});
// Fetch note categories from the server and populate the main section
fetch('https://example.com/api/notes-categories')
  .then(response => response.json())
  .then(data => {
    const main = document.querySelector('main');
    data.categories.forEach(category => {
      const categoryElement = document.createElement('div');
      categoryElement.classList.add('category');
      categoryElement.innerHTML = `
        <h2>${category.name}</h2>
        <p>${category.description}</p>
        <ul>
          ${category.notes.map(note => `
            <li><a href='notes.html?id=${note.id}'>${note.title}</a></li>
          `).join('')}
        </ul>
      `;
      main.appendChild(categoryElement);
    });
  });
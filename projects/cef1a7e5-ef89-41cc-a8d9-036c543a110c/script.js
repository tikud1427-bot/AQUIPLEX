I'm assuming there are HTML elements in the file for the buttons, and we have access to an API or some data to make the buttons functional. Here's a simple example of updating the script.js file to make buttons functional, assuming there are buttons with id "myButton":

// Add event listeners to buttons
document.getElementById('myButton').addEventListener('click', () => {
  // Example API call using Fetch API
  fetch('https://api.example.com/data')
    .then(response => response.json())
    .then(data => {
      // Process the data and update the website
      console.log(data); // Replace this with actual data processing and updating the website
    })
    .catch(error => {
      console.error('Error:', error);
    });
});

Please replace the API URL, data processing, and updating the website parts with the actual implementation based on the project requirements.
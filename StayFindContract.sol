// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract StayFindBooking {
    
    enum Status { Pending, Confirmed, Cancelled }
    
    struct Booking {
        uint256 propertyId;
        uint256 studentId;
        uint256 amount;
        Status status;
        address landlord;
    }

    // A mapping links the Booking ID to the Booking details
    mapping(uint256 => Booking) public bookings;

    // Emitted when a booking is successfully confirmed
    event BookingConfirmed(uint256 indexed bookingId, uint256 propertyId, uint256 amount);

    // This is the "Smart Contract Rule":
    // It automatically executes when the landlord confirms the student's payment.
    function confirmBooking(uint256 _bookingId, uint256 _propertyId, uint256 _studentId) public payable {
        // Rule 1: The landlord must send the required rent amount
        require(msg.value > 0, "Payment must be greater than zero");

        // Rule 2: The booking must not already exist
        require(bookings[_bookingId].studentId == 0, "Booking already exists");

        // Save the record to the blockchain (immutable)
        bookings[_bookingId] = Booking({
            propertyId: _propertyId,
            studentId: _studentId,
            amount: msg.value,
            status: Status.Confirmed,
            landlord: msg.sender
        });

        // Broadcast the transaction to the network
        emit BookingConfirmed(_bookingId, _propertyId, msg.value);
    }

    // A function to cancel a booking (releases the lock on the property)
    function cancelBooking(uint256 _bookingId) public {
        require(bookings[_bookingId].landlord == msg.sender, "Only the landlord can cancel");
        bookings[_bookingId].status = Status.Cancelled;
    }
}